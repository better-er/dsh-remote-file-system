/**
 * /remote-file-system RPC 端点：把 RemoteFileSystem 的读取能力暴露给浏览器半身。
 *
 * 内置右侧栏经 ctx.fs 读主机本地文件，读不到「别名:路径」的远端文件，
 * 因此 client 半身用本通道读取远端文本并自行渲染。
 *
 * @module dsh-remote-file-system/rpc
 */

import type { RemoteFileSystem } from './remote-fs.ts'
import type { RpcChannelResult } from './rpc-channel.ts'

/** 单次预览的字符上限，按 UTF-16 代码单元计，超出即截断并标记；bytes 仍回填完整文本的字节数。 */
const MAX_PREVIEW_CHARS = 2 * 1024 * 1024

/** 调用方参数不合法的错误，由 handleRemoteRpc 归 bad-request 而非 internal。 */
class BadRequestError extends Error {}

/** 把未知 payload 收窄成字符串字段表。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** 从字符串字段表里取字符串字段，缺失或类型不符返回 undefined。 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** 读取端点：payload 的 target 为「别名:路径」，返回路径、文本、字节数与截断标记。 */
async function readRemote(fs: RemoteFileSystem, payload: unknown): Promise<{ path: string; text: string; bytes: number; truncated: boolean }> {
  const target = readString(asRecord(payload), 'target')
  if (target === undefined || target.trim() === '') throw new BadRequestError('read 缺少 target')
  const resolved = await fs.resolve(target)
  const text = await fs.readText(resolved)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (text.length > MAX_PREVIEW_CHARS) {
    return { path: resolved.displayPath, text: text.slice(0, MAX_PREVIEW_CHARS), bytes, truncated: true }
  }
  return { path: resolved.displayPath, text, bytes, truncated: false }
}

/**
 * 处理一个端点，失败统一归 internal 信封，保留远端中文详情。
 * @param fs - 远程文件后端。
 * @param endpoint - 端点名。
 * @param payload - 载荷。
 */
export async function handleRemoteRpc(fs: RemoteFileSystem, endpoint: string, payload: unknown): Promise<RpcChannelResult> {
  try {
    switch (endpoint) {
      case 'read':
        return { ok: true, value: await readRemote(fs, payload) }
      default:
        return { ok: false, error: { code: 'bad-request', message: '未知端点: ' + endpoint, details: {} } }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (e instanceof BadRequestError) return { ok: false, error: { code: 'bad-request', message, details: {} } }
    return { ok: false, error: { code: 'internal', message, details: {} } }
  }
}
