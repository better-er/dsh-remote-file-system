/**
 * 远程工具的纯渲染辅助：读窗口、模型文本信封、diff hunk 卡片与 read 卡 meta。
 * 语义逐字移植自官方 @deepseek-ai/dsh-tool-fs，覆盖 read-render、diff、read、write、edit；不引该包，因其不导出这些，只为保持与原生卡片能力一致。
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { structuredPatch } from 'diff'

/** 单个 read 行。 */
export interface FileTextLine { number: number; text: string }
/** read 窗口请求。 */
export interface ReadWindowRequest {
  offset: number;
  limit: number;
  maxLineLength: number;
  maxBytes: number;
}
/** 读窗口结果。 */
export interface WindowResult {
  lines: FileTextLine[];
  totalLines: number;
  truncatedByBytes: boolean;
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? line.substring(0, maxLineLength) + '... (line truncated to ' + maxLineLength + ' chars)'
    : line
}
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 从整文件文本切出带行号的窗口。幻影空行与末尾无换行按原生语义处理，offset 越界抛 FS_NOT_FOUND。
 */
export function buildWindow(text: string, request: ReadWindowRequest, displayPath: string): WindowResult {
  const linesOut: FileTextLine[] = []
  let totalLines = 0
  let truncatedByBytes = false
  let outputBytes = 0

  // 逐行扫描：先精确统计 totalLines，同时收集窗口。
  // 解析规则：按 \n 切分，文件以换行结尾时不追加尾随空行，空文件为 0 行；
  // 无换行的残余也计为一行。与原生逐 chunk 扫描等价。
  const parts = text.split('\n')
  const hasTrailingNewline = text.endsWith('\n')
  const meaningful = hasTrailingNewline ? parts.slice(0, -1) : parts
  // 空文件：split 得空串且无末尾换行，故为 0 行
  if (text.length === 0) {
    return { lines: [], totalLines: 0, truncatedByBytes: false }
  }
  totalLines = meaningful.length
  for (let i = 0; i < meaningful.length; i += 1) {
    const raw = meaningful[i]
    if (truncatedByBytes) break
    const lineNumber = i + 1
    if (lineNumber < request.offset || linesOut.length >= request.limit) continue
    const shown = truncateLine(stripCarriageReturn(raw), request.maxLineLength)
    const bytes = Buffer.byteLength(shown, 'utf8') + (linesOut.length > 0 ? 1 : 0)
    if (outputBytes + bytes > request.maxBytes) { truncatedByBytes = true; break }
    outputBytes += bytes
    linesOut.push({ number: lineNumber, text: shown })
  }
  if (!truncatedByBytes && request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new FsError('offset ' + request.offset + ' is out of range for "' + displayPath + '" (' + totalLines + ' lines)', 'FS_NOT_FOUND')
  }
  return { lines: linesOut, totalLines, truncatedByBytes }
}
/** 读结果模型信封正文。 */
export interface FileReadOutcome {
  offset: number;
  lines: FileTextLine[];
  totalLines: number;
  truncatedByBytes?: true;
}
/** 组装 read 的模型可见信封文本，含行号与结尾说明。 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = '(Output capped. Showing lines ' + outcome.offset + '-' + endLine + '. Use offset=' + (endLine + 1) + ' to continue.)'
  } else if (endLine < outcome.totalLines) {
    footer = '(Showing lines ' + outcome.offset + '-' + endLine + ' of ' + outcome.totalLines + '. Use offset=' + (endLine + 1) + ' to continue.)'
  } else {
    footer = '(End of file - total ' + outcome.totalLines + ' lines)'
  }
  const body = outcome.lines.length > 0
    ? outcome.lines.map((line) => line.number + ': ' + line.text).join('\n') + '\n\n' + footer
    : footer
  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + body + '\n</content>'
}

/** 从路径推断高亮语言。 */
const LANG_BY_EXTENSION: Record<string, string> = {
  ts:'ts', tsx:'tsx', mts:'ts', cts:'ts', js:'js', jsx:'jsx', mjs:'js', cjs:'js',
  json:'json', jsonc:'json', py:'py', rb:'rb', go:'go', rs:'rs', java:'java',
  c:'c', h:'c', cc:'cpp', cpp:'cpp', hpp:'cpp', cxx:'cpp', cs:'cs', kt:'kotlin',
  swift:'swift', php:'php', sh:'sh', bash:'sh', zsh:'sh', yaml:'yaml', yml:'yaml',
  toml:'toml', ini:'ini', md:'md', markdown:'md', mdx:'mdx', html:'html', htm:'html',
  css:'css', scss:'scss', less:'less', sql:'sql', xml:'xml', lua:'lua',
}
/** 由路径扩展名取语言提示。 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/** read 卡的可回放 meta。 */
export interface FsReadMeta {
  path: string;
  offset: number;
  lines: FileTextLine[];
  totalLines: number;
  lang?: string;
}
/** 从回放 meta 收紧为合法 read 窗口，不合法返回 undefined 走通用卡。 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const m = meta as Record<string, unknown>
  const { path, offset, lines, totalLines, lang } = m
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every((l) => l !== null && typeof l === 'object'
    && !Array.isArray(l) && typeof (l as { number?: unknown }).number === 'number'
    && Number.isInteger((l as { number: number }).number) && (l as { number: number }).number >= 1
    && typeof (l as { text?: unknown }).text === 'string')) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  const typed = lines as FileTextLine[]
  let prev = offset - 1
  for (const { number } of typed) { if (number <= prev || number > totalLines) return undefined; prev = number }
  return { path, offset, lines: typed, totalLines, ...(lang === undefined ? {} : { lang }) }
}

/** write 与 edit 结果卡 meta，diffs 数组。 */
export type FsDiffMeta = { diffs: FileDiff[] }

/** 计算 before 与 after 的 hunk diff，3 行上下文，供结果卡展示。 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: 3 })
  const diffs: FileDiff[] = []
  for (const hunk of patch.hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) oldLines.push(text)
      else if (line.startsWith('+')) newLines.push(text)
      else { oldLines.push(text); newLines.push(text) }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') })
  }
  return diffs
}

/** 从回放 meta 收紧为合法 diffs，不合法返回 undefined。 */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const valid = diffs.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d)
    && typeof (d as { path?: unknown }).path === 'string'
    && ((d as { oldText?: unknown }).oldText === null || typeof (d as { oldText?: unknown }).oldText === 'string')
    && typeof (d as { newText?: unknown }).newText === 'string')
  return valid ? diffs as FileDiff[] : undefined
}

/** write 成功信封。 */
export function formatWriteOutput(displayPath: string, operation: 'create' | 'update'): string {
  const verb = operation === 'create' ? 'Created' : 'Updated'
  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + verb + ' file\n</content>'
}

/** edit 成功信封。 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? 'The file ' + displayPath + ' has been updated. All occurrences were successfully replaced.'
    : 'The file ' + displayPath + ' has been updated successfully.'
}
