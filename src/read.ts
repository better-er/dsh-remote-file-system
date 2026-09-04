/**
 * read_remote 工具定义。语义逐字移植自官方 read 与 read-render：行号分页、offset、limit、totalLines、幻影空行处理。
 * 唯一差异是走 RemoteFileSystem，即 ssh，且 file_path 支持「别名:路径」前缀。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { RemoteFileSystem } from './remote-fs.ts'
import {
  buildWindow,
  formatReadOutput,
  langFromPath,
  readMetaFromMeta,
} from './render.ts'

/** 读行上限、单行字符上限与输出字节上限，与原生 read 默认一致。 */
export const READ_LIMIT = 2000
export const READ_MAX_LINE_LENGTH = 2000
export const READ_MAX_BYTES = 50 * 1024

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer')
  }
  return value
}

interface ReadInput { filePath: string; offset: number; limit: number }

/** 校验 read_remote 参数：空 file_path 拒绝，offset 与 limit 须为正整数。 */
export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, 'limit')
  if (limit > READ_LIMIT) throw new Error('limit must be less than or equal to ' + READ_LIMIT)
  return { filePath: args.file_path, offset, limit }
}

/** 构建 read_remote 的 defineTool 对象。 */
export function createReadRemoteTool(fs: RemoteFileSystem): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'read_remote',
    description: 'Read a UTF-8 text file on a remote host over ssh and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Remote target and path in one: alias:path, e.g. wsl:~/x.md or myserver:/etc/hosts. Alias comes from your ssh config.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to ' + READ_LIMIT + '.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } } },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (args, value) => {
        const input = parseReadArgs(args as { file_path: string; offset?: number; limit?: number })
        const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
        const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
        return [{ type: 'text', text: formatReadOutput(value.path, { offset: value.offset, lines: value.lines, totalLines: value.totalLines, ...(truncatedByBytes ? { truncatedByBytes: true } : {}) }) }]
      },
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return { path: value.path, offset: value.offset, lines: value.lines.map(({ number, text }) => ({ number, text })), totalLines: value.totalLines, ...(lang === undefined ? {} : { lang }) }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args as { file_path: string; offset?: number; limit?: number })
      if (exec.signal.aborted) throw new FsError('cancelled', 'FS_ABORTED')
      const target = await fs.resolve(input.filePath)
      const text = await fs.readText(target)
      const window = buildWindow(text, { offset: input.offset, limit: input.limit, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES }, target.displayPath)
      return { path: target.displayPath, offset: input.offset, lines: window.lines, totalLines: window.totalLines }
    },
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return { card: 'read', path: meta.path, offset: meta.offset, lines: meta.lines, totalLines: meta.totalLines, ...(meta.lang === undefined ? {} : { lang: meta.lang }), content: [{ type: 'text', text: body }] }
    },
    presentCall(args): GenericCallView {
      const a = args as { file_path: string; offset?: number; limit?: number }
      const windowText = a.limit !== undefined && a.limit > 0
        ? ' (' + (a.offset ?? 1) + ' - ' + ((a.offset ?? 1) + a.limit - 1) + ')'
        : a.offset !== undefined ? ' (from line ' + a.offset + ')' : ''
      return { card: 'generic', title: 'Read ' + a.file_path + windowText, kind: 'read', locations: [{ path: a.file_path, line: a.offset ?? 1 }] }
    },
  })
}