// POSIX 远端冒烟：确认权限检查与错误码改动没有破坏原有分支
// 用法：RM_POSIX_TARGET="别名:/tmp/rm-smoke.txt" node smoke/posix-smoke.mjs
// 目标文件必须不存在，跑完会留在远端，记得自行删除目标与同名的 .bin
// 验证日期 2026-11-13
import { execFile } from 'node:child_process'
import { RemoteFileSystem } from '../src/remote-fs.ts'

const target = process.env.RM_POSIX_TARGET
if (!target) {
  console.error('请设置 RM_POSIX_TARGET，形如 别名:/tmp/rm-smoke.txt')
  process.exit(1)
}

const sep = target.indexOf(':')
const alias = target.slice(0, sep)
const rawPath = target.slice(sep + 1)

function sshRun(command) {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', alias, command], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
  })
}

const fs = new RemoteFileSystem()
const t = await fs.resolve(target)
await fs.writeText(t, '第一行\n第二行\n', { kind: 'createIfAbsent' })
console.log('stat:', JSON.stringify(await fs.stat(t)))
console.log('read:', JSON.stringify(await fs.readText(t)))

await sshRun("bash -lc 'echo external >> " + rawPath + "'")
try {
  await fs.editText(t, { oldString: '第二行', newString: '第二行 改过' })
  console.log('陈旧没被拦住')
} catch (err) {
  console.log('陈旧被拦:', err.code)
}

await fs.readText(t)
const e = await fs.editText(t, { oldString: '第二行', newString: '第二行 改过' })
console.log('edit 生效:', e.after.includes('改过'))

try {
  await fs.writeText(t, 'x', { kind: 'createIfAbsent' })
  console.log('重复新建没被拦住')
} catch (err) {
  console.log('重复新建被拦:', err.code)
}

const binPath = rawPath + '.bin'
await sshRun("bash -lc 'printf \"\\xff\\xfe\" > " + binPath + "'")
const bt = await fs.resolve(alias + ':' + binPath)
try {
  await fs.readText(bt)
  console.log('非文本没被拦住')
} catch (err) {
  console.log('非文本被拦:', err.code)
}
console.log('测试文件留在远端，记得删除:', target, '与', binPath)
