/**
 * 冒烟脚本：不启 LLM，手动组装最小 cordis 组合，即 SystemPrompt、ToolRuntime 与本插件，直接 execute read_remote、write_remote 与 edit_remote 对 wsl 冒烟，逐字节断言。
 *
 * 复用本插件的 node_modules 解析 @deepseek-ai，devDeps 已装同版本，与 host 共享原型。
 * 运行：node smoke/verify.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

const WSL = 'wsl'
const TEST = '~/dsh_remote_smoke.txt'
const signal = new AbortController().signal
let n = 0
function call(name, args) {
  return ctx.tools.execute({ signal, callId: ToolCallId('smoke-' + (++n)), name, arguments: args })
}
function text(result) { return result.content.filter((b) => b.type === 'text').map((b) => b.text).join('') }
function log(name, result, expect) {
  const err = result.isError ? (' [ERROR] ' + text(result)) : ''
  const ok = result.isError ? 'FAIL' : 'ok'
  console.log('  [' + ok + '] ' + name + err)
  if (result.isError && !expect) { process.exitCode = 1 }
}

let ctx
let fiber
let failures = 0
function assert(cond, msg) { if (!cond) { console.log('  ASSERT FAIL: ' + msg); failures++ } else { console.log('  assert ok: ' + msg) } }

try {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  fiber = await ctx.plugin(plugin)
  console.log('插件加载成功，name=', plugin.name)

  // 1. read_remote 读一个不存在的文件，应归 FS_NOT_FOUND
  let r = await call('read_remote', { file_path: WSL + ':' + TEST })
  assert(r.isError === true, 'read 不存在文件应报错，实际 isError=' + r.isError + '，text=' + text(r))

  // 2. write_remote 新建，文件不存在应成功
  r = await call('write_remote', { file_path: WSL + ':' + TEST, content: 'line one\nline two\nline three\n' })
  assert(!r.isError, 'write 新建应成功：' + text(r))

  // 3. write_remote 再写同一路径，已存在应拒绝，只新建
  r = await call('write_remote', { file_path: WSL + ':' + TEST, content: 'overwrite attempt\n' })
  assert(r.isError === true, 'write 已存在应拒绝，只允许新建，实际=' + text(r))

  // 4. read_remote 读回，验证内容
  r = await call('read_remote', { file_path: WSL + ':' + TEST })
  assert(!r.isError, 'read 应成功：' + text(r))
  const readBody = text(r)
  assert(readBody.includes('line two'), 'read 内容应含 line two，实际=' + readBody)
  assert(readBody.includes('End of file'), 'read 应报 End of file，实际=' + readBody)

  // 5. edit_remote 唯一匹配替换
  r = await call('edit_remote', { file_path: WSL + ':' + TEST, old_string: 'line two', new_string: 'line TWO' })
  assert(!r.isError, 'edit 应成功：' + text(r))
  r = await call('read_remote', { file_path: WSL + ':' + TEST })
  assert(text(r).includes('line TWO'), 'edit 后应含 line TWO')
  assert(!text(r).includes('line two'), 'edit 后不应再有 line two 小写')

  // 6. edit_remote 未命中，应归 FS_EDIT_NOT_FOUND
  r = await call('edit_remote', { file_path: WSL + ':' + TEST, old_string: '绝不存在的串', new_string: 'x' })
  assert(r.isError === true, 'edit 未命中应报错：' + text(r))

  // 7. 别名解析：相对路径拒绝
  r = await call('read_remote', { file_path: WSL + ':relative/path.txt' })
  assert(r.isError === true, '相对路径应拒绝：' + text(r))

  // 清理远端文件
  const { spawnSync } = await import('node:child_process')
  const clean = spawnSync('ssh', ['wsl', 'rm -f ~/dsh_remote_smoke.txt'], { encoding: 'utf8' })
  console.log('清理远端测试文件，exit=', clean.status)
} catch (e) {
  console.error('冒烟脚本异常:', e)
  process.exitCode = 1
} finally {
  if (fiber) await fiber.dispose().catch(() => {})
}

console.log('\n冒烟完成，断言失败数 = ' + failures)
process.exitCode = process.exitCode || (failures > 0 ? 1 : 0)