// Windows 远端冒烟：stat / read / edit / write，以及陈旧检查与非文本拦截
// 用法：RM_WIN_TARGET="别名:D:/temp/rm-smoke.txt" node smoke/remote-win-smoke.mjs
// 目标文件必须不存在，跑完会留在远端，记得自行删除目标与同名的 .bin
// 验证日期 2026-11-13
import { RemoteFileSystem } from '../src/remote-fs.ts'
import { sshExec, windowsCommand } from '../src/protocol.ts'

const target = process.env.RM_WIN_TARGET
if (!target) {
  console.error('请设置 RM_WIN_TARGET，形如 别名:D:/temp/rm-smoke.txt')
  process.exit(1)
}

const sep = target.indexOf(':')
const alias = target.slice(0, sep)
const rawPath = target.slice(sep + 1)
const quoted = rawPath.replace(/'/g, "''")

async function ps(script) {
  const out = await sshExec(alias, {}, '', {}, windowsCommand(script))
  if (out.exitCode !== 0) throw new Error('远端 PowerShell 失败: ' + out.stderr)
}

const fs = new RemoteFileSystem()
const t = await fs.resolve(target)
await fs.writeText(t, '第一行\n第二行\n', { kind: 'createIfAbsent' })
console.log('stat:', JSON.stringify(await fs.stat(t)))
console.log('read:', JSON.stringify(await fs.readText(t)))

// 读完之后从外部改一次，edit 应报陈旧
await ps("Add-Content -LiteralPath '" + quoted + "' -Value 'external'")
try {
  await fs.editText(t, { oldString: '第二行', newString: '第二行 改过' })
  console.log('陈旧没被拦住')
} catch (err) {
  console.log('陈旧被拦:', err.code)
}

// 重新读刷新观察后再编辑
await fs.readText(t)
const e = await fs.editText(t, { oldString: '第二行', newString: '第二行 改过' })
console.log('edit 生效:', e.after.includes('改过'))
console.log('edit 后内容:', JSON.stringify(await fs.readText(t)))

try {
  await fs.writeText(t, 'x', { kind: 'createIfAbsent' })
  console.log('重复新建没被拦住')
} catch (err) {
  console.log('重复新建被拦:', err.code)
}

const binPath = rawPath + '.bin'
await ps("[IO.File]::WriteAllBytes('" + binPath.replace(/'/g, "''") + "', [byte[]](0xFF,0xFE))")
const bt = await fs.resolve(alias + ':' + binPath)
try {
  await fs.readText(bt)
  console.log('非文本没被拦住')
} catch (err) {
  console.log('非文本被拦:', err.code)
}
console.log('测试文件留在远端，记得删除:', target, '与', binPath)
