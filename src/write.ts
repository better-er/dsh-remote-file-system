/**
 * write_remote 工具定义。语义移植自官方 write：全文件写、返回 before 与 after。
 * 恒用 createIfAbsent，只新建，目标已存在即拒绝，绝无覆写分支；diff 卡展示。
 * 无沙箱升级字段，见 DESIGN §7 刻意差异，schema 不声明 escalation 字段。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { RemoteFileSystem } from './remote-fs.ts'
import { computeHunkDiffs, diffsFromMeta, formatWriteOutput } from './render.ts'

interface WriteInput { filePath: string; content: string }

/** 校验 write_remote 参数：仅需非空 file_path，空 content 合法，可写空文件。 */
export function parseWriteArgs(args: { file_path: string; content: string }): WriteInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  return { filePath: args.file_path, content: args.content }
}

export function createWriteRemoteTool(fs: RemoteFileSystem): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'write_remote',
    description: 'Create a new UTF-8 text file on a remote host over ssh. The target must NOT already exist — write_remote only creates new files, never overwrites.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Remote target and path in one: alias:path, e.g. wsl:~/x.md or myserver:/etc/hosts. Must not already exist.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatWriteOutput(value.path, value.operation) }],
      presentationMeta: (args, value) => ({ diffs: value.before === null ? [] : computeHunkDiffs((args as { file_path: string }).file_path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })) }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseWriteArgs(args as { file_path: string; content: string })
      if (exec.signal.aborted) throw new FsError('cancelled', 'FS_ABORTED')
      const target = await fs.resolve(input.filePath)
      const outcome = await fs.writeText(target, input.content, { kind: 'createIfAbsent' })
      return { path: target.displayPath, operation: outcome.operation, before: outcome.before, after: outcome.after }
    },
    presentCall(args): DiffCallView {
      const a = args as { file_path: string; content: string }
      return { card: 'diff', title: 'Write ' + a.file_path, diffs: [{ path: a.file_path, oldText: null, newText: a.content }], locations: [{ path: a.file_path }] }
    },
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const a = args as { file_path: string; content: string }
      const diffs = diffsFromMeta(result.meta) ?? [{ path: a.file_path, oldText: null, newText: a.content }]
      return { card: 'diff', title: 'Write ' + a.file_path, diffs }
    },
  })
}