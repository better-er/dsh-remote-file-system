// 远程文件地址解析冒烟：POSIX、Windows 盘符、反斜杠、编码与非法输入
// 用法：node smoke/address-smoke.mjs
// 验证日期 2026-11-14
import assert from 'node:assert/strict'
import { basenameOf, parseRemoteAddress } from '../src/address.ts'

const SESSION = 'dsh-resource://file/session/s1/'

function ok(address, expected) {
  const parsed = parseRemoteAddress(address)
  assert.notEqual(parsed, null, '应认领：' + address)
  assert.equal(parsed.alias, expected.alias, address)
  assert.equal(parsed.rawPath, expected.rawPath, address)
  assert.equal(parsed.target, expected.alias + ':' + expected.rawPath, address)
  console.log('认领', address, '→', parsed.target)
}

function rejected(address) {
  assert.equal(parseRemoteAddress(address), null, '不应认领：' + address)
  console.log('拒绝', address)
}

ok(SESSION + 'wsl:~/x.md', { alias: 'wsl', rawPath: '~/x.md' })
ok(SESSION + 'myserver:/etc/hosts', { alias: 'myserver', rawPath: '/etc/hosts' })
ok(SESSION + 'uu:C:/Windows/win.ini', { alias: 'uu', rawPath: 'C:/Windows/win.ini' })
ok(SESSION + 'winbox:C:%5Cwork%5Ctest.txt', { alias: 'winbox', rawPath: 'C:\\work\\test.txt' })
ok(SESSION + 'uu:D:/Program%20Files/a%23b.txt', { alias: 'uu', rawPath: 'D:/Program Files/a#b.txt' })

rejected('dsh-resource://file/absolute/C:/x/y.txt')
rejected(SESSION + 'c:/x.md')
rejected(SESSION + 'uu:relative/x.md')
rejected(SESSION + 'uu')
rejected(SESSION)

assert.equal(basenameOf('C:/Windows/win.ini'), 'win.ini')
assert.equal(basenameOf('C:\\work\\test.txt'), 'test.txt')
assert.equal(basenameOf('/etc/hosts'), 'hosts')
assert.equal(basenameOf('~/'), '~/')
console.log('basename 全部通过')
console.log('address smoke 通过')
