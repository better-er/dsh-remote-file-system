// Windows 远端冒烟：stat / read / edit / write 全部走 PowerShell 分支
// 用法：RM_WIN_TARGET="别名:D:/temp/rm-smoke.txt" node smoke/remote-win-smoke.mjs
// 目标文件必须不存在，跑完会留在远端，记得自行删除
// 验证日期 2026-11-13
import { RemoteFileSystem } from '../src/remote-fs.ts'

const target = process.env.RM_WIN_TARGET
if (!target) {
  console.error('请设置 RM_WIN_TARGET，形如 别名:D:/temp/rm-smoke.txt')
  process.exit(1)
}

const fs = new RemoteFileSystem()
const t = await fs.resolve(target)
await fs.writeText(t, '第一行\n第二行\n', { kind: 'createIfAbsent' })
console.log('stat:', JSON.stringify(await fs.stat(t)))
console.log('read:', JSON.stringify(await fs.readText(t)))

const e = await fs.editText(t, { oldString: '第二行', newString: '第二行 改过' })
console.log('edit 生效:', e.after.includes('改过'))
console.log('edit 后内容:', JSON.stringify(await fs.readText(t)))

try {
  await fs.writeText(t, 'x', { kind: 'createIfAbsent' })
  console.log('重复新建没被拦住')
} catch (err) {
  console.log('重复新建被拦:', err.code)
}
console.log('测试文件留在远端，记得删除:', target)
