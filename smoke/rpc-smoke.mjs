/**
 * RPC 通道冒烟：直接用源码的 rpc-channel 与 rpc 组装，挂到临时 http server 上，
 * 用真实信封验证 /remote-file-system/read 与各错误分支。
 *
 * 只 import 这两支纯模块，它们运行时不依赖 @deepseek-ai 包，
 * 因此绕开了 devDeps 的 peer 缺失，也不加载 host 入口。
 *
 * 运行：node smoke/rpc-smoke.mjs
 */
import { createServer } from 'node:http'
import { mountRpcChannel } from '../src/rpc-channel.ts'
import { handleRemoteRpc } from '../src/rpc.ts'

let failures = 0
function assert(cond, msg) {
  if (cond) { console.log('  assert ok: ' + msg) } else { console.log('  ASSERT FAIL: ' + msg); failures++ }
}

/** 假远程后端，只实现 handler 用到的 resolve 与 readText。 */
const fakeFs = {
  resolve: async (path) => ({ targetKey: path, displayPath: path }),
  readText: async (target) => {
    if (target.displayPath === 'wsl:/missing') throw new Error('文件不存在')
    return '你好\nworld\n'
  },
}

const routes = []
const channel = '/remote-file-system'
mountRpcChannel({
  inject: (_deps, callback) => {
    callback({
      connection: { requestRejection: () => undefined },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      effect: (callback) => { callback(); return () => {} },
    })
  },
}, channel, (endpoint, payload) => handleRemoteRpc(fakeFs, endpoint, payload))

assert(routes.length === 1, '注册了 1 条路由，实际 ' + routes.length)
assert(routes[0] !== undefined && routes[0].path === channel, '路由前缀正确')

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const matched = routes.find((r) => url.pathname.startsWith(r.path + '/'))
  if (matched === undefined) { res.writeHead(404); res.end('no route'); return }
  Promise.resolve(matched.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)) })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

async function call(method, payload, contentType) {
  const res = await fetch('http://127.0.0.1:' + port + channel + '/' + method, {
    method: 'POST',
    headers: { 'content-type': contentType === undefined ? 'application/json' : contentType },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-' + method, method, payload }),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

try {
  const ok = await call('read', { target: 'wsl:/etc/hostname' })
  assert(ok.status === 200, 'read 返回 200，实际 ' + ok.status)
  assert(ok.body.result !== undefined && ok.body.result.ok === true, 'read 成功')
  if (ok.body.result !== undefined && ok.body.result.ok === true) {
    assert(ok.body.result.value.text.includes('你好'), 'text 内容正确')
    assert(ok.body.result.value.path === 'wsl:/etc/hostname', 'path 回填正确')
    assert(ok.body.result.value.truncated === false, 'truncated 为 false')
  }

  const unknown = await call('nope', {})
  assert(unknown.body.result !== undefined && unknown.body.result.ok === false, '未知端点被拒绝')

  const missing = await call('read', {})
  assert(missing.body.result !== undefined && missing.body.result.ok === false, '缺少 target 被拒绝')
  assert(missing.body.result.error.code === 'bad-request', '缺少 target 归 bad-request')

  const remoteErr = await call('read', { target: 'wsl:/missing' })
  assert(remoteErr.body.result !== undefined && remoteErr.body.result.ok === false, '远端错误归失败帧')
  assert(remoteErr.body.result.error.message.includes('文件不存在'), '远端错误详情保留')

  const wrongMime = await call('read', { target: 'wsl:/etc/hostname' }, 'text/plain')
  assert(wrongMime.status === 415, '错误 content-type 返回 415，实际 ' + wrongMime.status)

  const mismatch = await fetch('http://127.0.0.1:' + port + channel + '/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'other', payload: {} }),
  })
  const mismatchBody = await mismatch.json()
  assert(mismatchBody.result !== undefined && mismatchBody.result.ok === false, 'method 与端点不符被拒绝')
} finally {
  await new Promise((resolve) => server.close(resolve))
}

console.log(failures === 0 ? 'PASS' : 'FAIL ' + failures)
process.exitCode = failures === 0 ? 0 : 1
