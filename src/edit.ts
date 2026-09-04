/**
 * edit_remote 工具定义。
 * 语义移植自官方 edit：字面替换、唯一匹配，多现拒绝即 FS_AMBIGUOUS_EDIT，未命中即 FS_EDIT_NOT_FOUND；拒绝 old_string 与 new_string 相同；replace_all 全替换。
 * 匹配类错误由后端抛原生词表。无沙箱升级字段。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { RemoteFileSystem } from './remote-fs.ts'
import { computeHunkDiffs, diffsFromMeta, formatEditOutput } from './render.ts'

interface EditInput { filePath: string; oldString: string; newString: string; replaceAll: boolean }

/** 校验 edit_remote 参数。 */
export function parseEditArgs(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return { filePath: args.file_path, oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false }
}

export function createEditRemoteTool(fs: RemoteFileSystem): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'edit_remote',
    description: 'Edit an existing UTF-8 text file on a remote host over ssh by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Remote target and path in one: alias:path, e.g. wsl:~/x.md or myserver:/etc/hosts.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: formatEditOutput(value.path, (args as { replace_all?: boolean }).replace_all ?? false) }],
      presentationMeta: (args, value) => ({ diffs: computeHunkDiffs((args as { file_path: string }).file_path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })) }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = parseEditArgs(args as { file_path: string; old_string: string; new_string: string; replace_all?: boolean })
      if (exec.signal.aborted) throw new FsError('cancelled', 'FS_ABORTED')
      const target = await fs.resolve(input.filePath)
      const outcome = await fs.editText(target, { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll })
      return { path: target.displayPath, before: outcome.before, after: outcome.after }
    },
    presentCall(args): DiffCallView {
      const a = args as { file_path: string; old_string: string; new_string: string }
      return { card: 'diff', title: 'Edit ' + a.file_path, diffs: [{ path: a.file_path, oldText: a.old_string || null, newText: a.new_string }], locations: [{ path: a.file_path }] }
    },
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const a = args as { file_path: string }
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: 'Edit ' + a.file_path, diffs }
    },
  })
}