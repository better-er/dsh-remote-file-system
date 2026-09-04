/**
 * 远端执行协议：host 进程内用子进程 ssh 对远程主机执行一条 bash 脚本。
 *
 * 可变数据即路径与写内容，一律 base64 编码，经环境变量传给远端，值用单引号包裹。
 * base64 只含 [A-Za-z0-9+/=]，不夹带单引号或换行，从根上避开 shell 引号转义与注入。
 * 远端统一用 bash -s 从 stdin 读脚本，字节经 base64 传输，不受本地 shell 方言约束。
 *
 * 结果约定：脚本成功写 stdout，内容是 base64 或留空；失败向 stderr 打一行 __ERR__<code>__<message> 并 exit 1。
 * 本地据此归 FsError，保留远端中文详情。
 */

import { spawn } from 'node:child_process'
import { FsError } from '@deepseek-ai/dsh-fs'

const ERR_PREFIX = '__ERR__'

/** base64 编码。 */
export function b64(input: string): string { return Buffer.from(input, 'utf8').toString('base64') }
/** base64 解码为 utf8。 */
export function b64d(input: string): string { return Buffer.from(input, 'base64').toString('utf8') }

/**
 * 在远端 bash 里解码 RM_PATH 环境变量并做 ~/ 展开。返回一段可拼进脚本前部的代码。
 * 注：不直接内嵌复杂 bash，只用最简 case，~/ 展开交给远端 $HOME。
 */
export const PATH_PROLOGUE = [
  'set +e',
  'b64d() { printf %s "$1" | base64 -d 2>/dev/null; }',
  'P=$(b64d "$RM_PATH")',
  'case "$P" in "~"*) eval "P=\"$P\"" ;; esac',
].join('\n')

/** 拼出远端命令行的 env 前缀：VAR='<b64>' VAR2=... bash -s。 */
export function envPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => k + "='" + v + "'")
    .join(' ') + ' bash -s'
}

/** 一次 ssh 调用的输出。 */
export interface SshRawResult { exitCode: number | null; stdout: string; stderr: string }

/**
 * 执行远端脚本。env 提供 base64 数据变量，脚本主体写进 stdin。
 * 返回原始 ssh 输出，未做成功与失败判定。
 */
export async function sshExec(
  alias: string,
  env: Record<string, string>,
  scriptBody: string,
  opts: { timeoutMs?: number } = {},
): Promise<SshRawResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  return await new Promise<SshRawResult>((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=' + Math.max(1, Math.floor(timeoutMs / 1000)),
      alias,
      envPrefix(env),
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer)
      reject(new Error('ssh 连接失败：' + err.message))
    })
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer)
      resolve({ exitCode: timedOut ? -1 : code, stdout, stderr })
    })
    child.stdin.write(scriptBody)
    child.stdin.end()
  })
}

/**
 * 执行并把结果翻译成本地约定：exit 0 视为成功，返回 stdout 文本；否则解析 stderr 首行 __ERR__<code>__<message> 归对应 FsError，找不到则统一 FS_IO_ERROR 并带详情。
 * 超时即 exit -1，归 FS_IO_ERROR。
 */
export async function sshOutcome(
  alias: string,
  env: Record<string, string>,
  scriptBody: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ code: string; stdout: string }> {
  const raw = await sshExec(alias, env, scriptBody, opts).catch((e: Error) => {
    throw new FsError(e.message, 'FS_IO_ERROR')
  })
  if (raw.exitCode === -1) throw new FsError('远程执行超时', 'FS_IO_ERROR')
  if (raw.exitCode === 0) return { code: 'OK', stdout: raw.stdout }
  // 解析 stderr 的 __ERR__ 行
  const line = raw.stderr.split('\n').find((l: string) => l.startsWith(ERR_PREFIX))
  if (line) {
    const rest = line.slice(ERR_PREFIX.length)
    const sep = rest.indexOf('__')
    const code = sep === -1 ? 'FS_IO_ERROR' : rest.slice(0, sep)
    const message = sep === -1 ? rest : rest.slice(sep + 2)
    throw new FsError(message || '远程执行失败', code === 'FS_IO_ERROR' ? 'FS_IO_ERROR' : (code as never))
  }
  const detail = raw.stderr.trim() || '远程执行失败且无输出'
  throw new FsError(detail, 'FS_IO_ERROR')
}

/** 远端 bash 失败打一行 __ERR__ 并退出的辅助片段，拼进脚本。 */
export const DIE_HELPER = [
  'die() { local c="$1"; shift; local m="$*"; echo "__ERR__${c}__${m}" >&2; exit 1; }',
].join('\n')

/** 远端 bash 输出 base64 的辅助。echo_b64() { printf %s "$1" | base64 -w0; } */
export const B64_HELPER = [
  'b64out() { printf %s "$1" | base64 -w0 2>/dev/null; }',
].join('\n')
