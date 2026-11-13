/**
 * RemoteFileSystem — 远程文件后端层。
 *
 * 刻意不继承 @deepseek-ai/dsh-fs 的 FileSystem 与 cordis Service。
 * FileSystem 是 Service 子类，构造即注册为 ctx.fs，继承会污染会话级 ctx.fs，实测见 DESIGN §9.2。
 * 这里只借用 dsh-fs 的类型词表与 FsError，方法面同构 FileSystem，仅实现远程读写用到的子集。
 *
 * 实现走 ssh：host 进程内对同一 targetKey 加 per-target 锁，串行本 agent 读改写；远端发布用「同目录临时文件 + mv」近似原子，createIfAbsent 用 no-clobber 近似。
 * 原子性只保证 host 进程内与单条 ssh 命令内，跨连接与跨主机并发覆盖为已接受局限，见 DESIGN §7。
 */

import {
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsEditRequest,
  FsEditOutcome,
  FsInfo,
  FsTarget,
  FsVersion as FsVersionType,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { createHash } from 'node:crypto'
import { b64, PATH_PROLOGUE, DIE_HELPER, B64_HELPER, sshOutcome } from './protocol.ts'

/** 每 targetKey 串行队列，维护每个 key 的尾 Promise。 */
const TAILS = new Map<string, Promise<unknown>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = TAILS.get(key) ?? Promise.resolve()
  const run = prev.then(() => fn())
  TAILS.set(key, run.catch(() => {}))
  return run
}

const ALIAS_RE = /^[A-Za-z0-9._-]+$/

/** 生成 Windows 分支的公共前导：解码路径、展开 ~/、统一错误输出。 */
function winPrologue(rawPath: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    'function Die($c,$m){ [Console]::Error.WriteLine("__ERR__"+$c+"__"+$m); exit 1 }',
    'function Decode($s){ [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }',
    "$P = Decode('" + b64(rawPath) + "')",
    "if ($P.StartsWith('~/')) { $P = Join-Path $env:USERPROFILE $P.Substring(2) }",
  ].join('\n')
}

/** 解析「别名:路径」。路径须绝对或 ~/ 开头，裸相对路径拒绝。 */
export function splitAliasPath(filePath: string): { alias: string; rawPath: string } {
  const idx = filePath.indexOf(':')
  if (idx <= 0) throw new FsError('file_path 须为「别名:路径」形式，缺少别名前缀：' + filePath, 'FS_IO_ERROR')
  const alias = filePath.slice(0, idx)
  const rawPath = filePath.slice(idx + 1)
  if (!ALIAS_RE.test(alias)) throw new FsError('非法的别名前缀：' + alias, 'FS_IO_ERROR')
  const winAbs = /^[A-Za-z]:[\\/]/.test(rawPath)
  if (!(rawPath.startsWith('/') || rawPath.startsWith('~/') || winAbs)) {
    throw new FsError('远程路径只接受绝对路径、~/ 或盘符开头，收到相对路径：' + rawPath, 'FS_IO_ERROR')
  }
  return { alias, rawPath }
}

/**
 * RemoteFileSystem 后端。普通类，不继承 FileSystem 与 cordis Service，不注册服务。
 */
export class RemoteFileSystem {
  /** 单次读取字节上限，超限拒绝且不做流式，见 DESIGN §7 资源上限。 */
  readonly readMaxBytes = 50 * 1024 * 1024

  /** 读过的内容指纹，供 editText 判断「读到之后又被改过」。只在 host 进程内有效。 */
  private readonly observed = new Map<string, string>()

  private fingerprint(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }

  /** 解析「别名:路径」为稳定 FsTarget。targetKey 含 alias 与 rawPath，displayPath 即原名。 */
  async resolve(path: string): Promise<FsTarget> {
    const { alias, rawPath } = splitAliasPath(path)
    const displayPath = alias + ':' + rawPath
    return { targetKey: FsTargetKey(alias + '::' + rawPath), displayPath }
  }

  /** FileSystem 同形占位：无进程内路径，返回 displayPath。 */
  processPath(target: FsTarget): string { return target.displayPath }

  /** stat：类型 + size + 版本依据，缺失返回 undefined。版本只作 host 进程内陈旧排序。 */
  async stat(target: FsTarget): Promise<FsInfo | undefined> {
    return withLock(target.targetKey, () => this.statLocked(target))
  }

  private async statLocked(target: FsTarget): Promise<FsInfo | undefined> {
    const { alias, rawPath } = splitAliasPath(target.displayPath)
    const env = { RM_PATH: b64(rawPath) }
    // 存在与否与类型判定在远端一次完成，把结果打进 stdout，失败则 die
    const action = [
      PATH_PROLOGUE,
      DIE_HELPER,
      'if [ ! -e "$P" ] && [ ! -L "$P" ]; then echo ABSENT; exit 0; fi',
      'if [ -L "$P" ]; then echo OTHER; exit 0; fi',
      'if [ -d "$P" ]; then echo DIR; exit 0; fi',
      'if [ ! -f "$P" ]; then echo OTHER; exit 0; fi',
      'SIZE=$(wc -c < "$P" 2>/dev/null | tr -d " ")',
      'MT=$(stat -c %Y "$P" 2>/dev/null || echo 0)',
      'echo "FILE:$SIZE:$MT"',
    ].join('\n')
    const winScript = [
      winPrologue(rawPath),
      'try {',
      '  $i = Get-Item -LiteralPath $P -Force -ErrorAction Stop',
      "  if ($i.PSIsContainer) { 'DIR' }",
      "  elseif ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'OTHER' }",
      "  elseif ($i -is [IO.FileInfo]) { 'FILE:' + $i.Length + ':' + ([DateTimeOffset]$i.LastWriteTimeUtc).ToUnixTimeSeconds() }",
      "  else { 'OTHER' }",
      "} catch { 'ABSENT' }",
    ].join('\n')
    const out = await sshOutcome(alias, env, action, {}, { script: winScript })
    const s = out.stdout.trim()
    if (s === 'ABSENT') return undefined
    if (s === 'DIR') return { version: FsVersion('dir:' + Date.now()), type: 'directory' }
    if (s === 'OTHER') return { version: FsVersion('other:' + Date.now()), type: 'other' }
    const m = /^FILE:(\d*):(\d*)$/.exec(s)
    const size = m && m[1] !== '' ? Number(m[1]) : undefined
    const mtime = m && m[2] !== '' ? m[2] : '0'
    return {
      version: FsVersion('m:' + mtime + (size !== undefined ? ':' + size : '')),
      type: 'file',
      ...(size !== undefined ? { size } : {}),
    }
  }

  /** 读整文件 utf8。缺失归 FS_NOT_FOUND，非普通归 FS_NOT_REGULAR_FILE，超限归 FS_TOO_LARGE。 */
  async readText(target: FsTarget): Promise<string> {
    return withLock(target.targetKey, async () => {
      const text = await this.readTextLocked(target)
      this.observed.set(target.targetKey, this.fingerprint(text))
      return text
    })
  }

  private async readTextLocked(target: FsTarget): Promise<string> {
    const { alias, rawPath } = splitAliasPath(target.displayPath)
    const env = { RM_PATH: b64(rawPath), RM_MAX: String(this.readMaxBytes) }
    const action = [
      PATH_PROLOGUE,
      DIE_HELPER,
      'if [ ! -e "$P" ] && [ ! -L "$P" ]; then die FS_NOT_FOUND 文件不存在; exit 0; fi',
      'if [ -d "$P" ]; then die FS_NOT_REGULAR_FILE 目标是一个目录; exit 0; fi',
      'if [ ! -f "$P" ]; then die FS_NOT_REGULAR_FILE 目标不是普通文件; exit 0; fi',
      'if [ ! -r "$P" ]; then die FS_PERMISSION_DENIED 没有读取权限; exit 0; fi',
      'SIZE=$(wc -c < "$P" 2>/dev/null | tr -d " ")',
      'if [ -n "$SIZE" ] && [ "$SIZE" -gt "$RM_MAX" ] 2>/dev/null; then die FS_TOO_LARGE 文件超过单次读取上限，不做流式; exit 0; fi',
      'base64 -w0 < "$P" 2>/dev/null || die FS_IO_ERROR 读取内容失败',
    ].join('\n')
    const winScript = [
      winPrologue(rawPath),
      "if (-not (Test-Path -LiteralPath $P)) { Die 'FS_NOT_FOUND' '文件不存在'; exit 0 }",
      "if (Test-Path -LiteralPath $P -PathType Container) { Die 'FS_NOT_REGULAR_FILE' '目标是目录'; exit 0 }",
      'try {',
      '  $b = [IO.File]::ReadAllBytes($P)',
      '} catch [System.UnauthorizedAccessException] {',
      "  Die 'FS_PERMISSION_DENIED' '没有权限'; exit 0",
      '} catch {',
      "  Die 'FS_IO_ERROR' $_.Exception.Message; exit 0",
      '}',
      'if ($b.Length -gt ' + this.readMaxBytes + ") { Die 'FS_TOO_LARGE' '文件超过单次读取上限'; exit 0 }",
      '[Convert]::ToBase64String($b)',
    ].join('\n')
    const out = await sshOutcome(alias, env, action, {}, { script: winScript })
    const raw = Buffer.from(out.stdout.replace(/\s+$/u, ''), 'base64')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      throw new FsError('目标不是有效的 UTF-8 文本', 'FS_NOT_TEXT')
    }
  }

  /** readBytes：raw 读取，文本只读，返回 utf8 字节。 */
  async readBytes(target: FsTarget, maxBytes: number): Promise<Uint8Array> {
    const text = await this.readText(target)
    const buf = Buffer.from(text, 'utf8')
    if (buf.byteLength > maxBytes) throw new FsError('超出字节上限', 'FS_TOO_LARGE')
    return buf
  }

  /**
   * 全文件写，恒用 createIfAbsent，只新建。目标已存在即 FS_NOT_OBSERVED，绝无覆写。
   * 只接受 createIfAbsent 意图，其他拒绝。
   */
  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    return withLock(target.targetKey, () => this.writeTextLocked(target, content, expected))
  }

  private async writeTextLocked(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const { alias, rawPath } = splitAliasPath(target.displayPath)
    if (expected !== undefined && expected.kind !== 'createIfAbsent') {
      throw new FsError('write_remote 只允许新建，仅支持 createIfAbsent 意图', 'FS_NOT_OBSERVED')
    }
    const env = { RM_PATH: b64(rawPath) }
    const data = b64(content)
    const action = [
      PATH_PROLOGUE,
      DIE_HELPER,
      'D=$(dirname "$P")',
      'if [ ! -d "$D" ]; then die FS_NOT_FOUND 目标目录不存在; exit 0; fi',
      'if [ ! -w "$D" ]; then die FS_PERMISSION_DENIED 目标目录不可写; exit 0; fi',
      'TMP=$(mktemp "$P.XXXXXXXX.tmp" 2>/dev/null)',
      'if [ -z "$TMP" ]; then die FS_IO_ERROR 无法创建临时文件; exit 0; fi',
      `printf %s '${data}' | base64 -d > "$TMP" 2>/dev/null || { rm -f "$TMP"; die FS_IO_ERROR 写入临时文件失败; exit 0; }`,
      'if [ -e "$P" ] || [ -L "$P" ]; then rm -f "$TMP"; die FS_NOT_OBSERVED 文件已存在，write_remote 只允许新建; exit 0; fi',
      'mv -f "$TMP" "$P" 2>/dev/null || { rm -f "$TMP"; die FS_IO_ERROR mv 发布失败; exit 0; }',
      'echo OK',
    ].join('\n')
    const winScript = [
      winPrologue(rawPath),
      '$in = [Console]::In.ReadToEnd()',
      '$data = [Convert]::FromBase64String($in.Trim())',
      "if (Test-Path -LiteralPath $P) { Die 'FS_NOT_OBSERVED' '文件已存在，write_remote 只允许新建'; exit 0 }",
      '$dir = [IO.Path]::GetDirectoryName($P)',
      "if (-not $dir) { $dir = '.' }",
      "if (-not (Test-Path -LiteralPath $dir)) { Die 'FS_NOT_FOUND' '目标目录不存在'; exit 0 }",
      '$tmp = Join-Path $dir ([IO.Path]::GetRandomFileName())',
      'try {',
      '  [IO.File]::WriteAllBytes($tmp, $data)',
      '} catch [System.UnauthorizedAccessException] {',
      "  Die 'FS_PERMISSION_DENIED' '没有权限'; exit 0",
      '} catch {',
      "  Die 'FS_IO_ERROR' $_.Exception.Message; exit 0",
      '}',
      'try {',
      "  if (Test-Path -LiteralPath $P) { throw 'exists' }",
      '  Move-Item -LiteralPath $tmp -Destination $P -ErrorAction Stop',
      '} catch {',
      '  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue',
      "  Die 'FS_NOT_OBSERVED' '文件已存在，write_remote 只允许新建'; exit 0",
      '}',
      "'OK'",
    ].join('\n')
    await sshOutcome(alias, env, action, {}, { script: winScript, input: data })
    this.observed.set(target.targetKey, this.fingerprint(content))
    return { operation: 'create', version: FsVersion('w:' + Date.now()), before: null, after: content }
  }

  /** 编辑后写回，整块替换。 */
  private async writeReplaced(target: FsTarget, content: string): Promise<string> {
    const { alias, rawPath } = splitAliasPath(target.displayPath)
    const env = { RM_PATH: b64(rawPath) }
    const data = b64(content)
    const action = [
      PATH_PROLOGUE,
      DIE_HELPER,
      'D=$(dirname "$P")',
      'if [ ! -d "$D" ]; then die FS_NOT_FOUND 目标目录不存在; exit 0; fi',
      'TMP=$(mktemp "$P.XXXXXXXX.tmp" 2>/dev/null)',
      'if [ -z "$TMP" ]; then die FS_IO_ERROR 无法创建临时文件; exit 0; fi',
      `printf %s '${data}' | base64 -d > "$TMP" 2>/dev/null || { rm -f "$TMP"; die FS_IO_ERROR 写入临时文件失败; exit 0; }`,
      'if [ ! -e "$P" ]; then rm -f "$TMP"; die FS_NOT_FOUND 文件已不存在; exit 0; fi',
      'if [ ! -w "$P" ]; then rm -f "$TMP"; die FS_PERMISSION_DENIED 文件不可写; exit 0; fi',
      'mv -f "$TMP" "$P" 2>/dev/null || { rm -f "$TMP"; die FS_IO_ERROR mv 替换失败; exit 0; }',
      'echo OK',
    ].join('\n')
    const winScript = [
      winPrologue(rawPath),
      '$in = [Console]::In.ReadToEnd()',
      '$data = [Convert]::FromBase64String($in.Trim())',
      '$dir = [IO.Path]::GetDirectoryName($P)',
      "if (-not $dir) { $dir = '.' }",
      "if (-not (Test-Path -LiteralPath $dir)) { Die 'FS_NOT_FOUND' '目标目录不存在'; exit 0 }",
      '$tmp = Join-Path $dir ([IO.Path]::GetRandomFileName())',
      'try {',
      '  [IO.File]::WriteAllBytes($tmp, $data)',
      '} catch [System.UnauthorizedAccessException] {',
      "  Die 'FS_PERMISSION_DENIED' '没有权限'; exit 0",
      '} catch {',
      "  Die 'FS_IO_ERROR' $_.Exception.Message; exit 0",
      '}',
      "if (-not (Test-Path -LiteralPath $P)) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; Die 'FS_NOT_FOUND' '文件已不存在'; exit 0 }",
      'try { Move-Item -LiteralPath $tmp -Destination $P -Force -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; Die \'FS_IO_ERROR\' \'替换失败\'; exit 0 }',
      "'OK'",
    ].join('\n')
    await sshOutcome(alias, env, action, {}, { script: winScript, input: data })
    return content
  }

  /**
   * 字面编辑：读原文 → host 内唯一匹配或全替换 → 写回。匹配类错误走原生词表，即 FS_AMBIGUOUS_EDIT 与 FS_EDIT_NOT_FOUND；远端失败归远程失败类。
   * 整块读改写，保留远端换行。
   */
  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    _expected?: { version: FsVersionType } | undefined,
  ): Promise<FsEditOutcome> {
    return withLock(target.targetKey, async () => {
      const { alias, rawPath } = splitAliasPath(target.displayPath)
      // 先读原文，锁内读改写临界区，缺失即 FS_NOT_FOUND
      const readTarget: FsTarget = { targetKey: target.targetKey, displayPath: alias + ':' + rawPath }
      const before = await this.readTextLocked(readTarget)
      const seen = this.observed.get(target.targetKey)
      if (seen !== undefined && seen !== this.fingerprint(before)) {
        throw new FsError('文件在读取后已被修改，请先重新读取再编辑', 'FS_STALE_VERSION')
      }
      const matches = this.countMatches(before, edit.oldString)
      if (matches === 0) throw new FsError('old_string 未命中任何匹配', 'FS_EDIT_NOT_FOUND')
      if (!edit.replaceAll && matches > 1) {
        throw new FsError('old_string 出现 ' + matches + ' 次，需更精确或设 replace_all', 'FS_AMBIGUOUS_EDIT')
      }
      const after = edit.replaceAll
        ? before.split(edit.oldString).join(edit.newString)
        : before.replace(edit.oldString, edit.newString)
      await this.writeReplaced(readTarget, after)
      this.observed.set(target.targetKey, this.fingerprint(after))
      return { version: FsVersion('e:' + Date.now()), before, after }
    })
  }

  private countMatches(text: string, oldString: string): number {
    if (oldString === '') return 0
    let count = 0
    let idx = text.indexOf(oldString)
    while (idx !== -1) { count++; idx = text.indexOf(oldString, idx + oldString.length) }
    return count
  }
}
