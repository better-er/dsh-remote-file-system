/**
 * 远程文件地址解析：从 dsh-resource 文件地址里认出「别名:路径」。
 *
 * 单独成模块而不留在 client.ts，是为了不依赖 React，让 smoke 能直接对纯函数验证。
 * 地址语法见 @deepseek-ai/dsh-util-workspace-path 的 file-address.ts：
 * 每个路径段逐个 component-encode，反斜杠在生成地址时已规范化为正斜杠。
 *
 * @module dsh-remote-file-system/address
 */

/** 会话文件资源地址前缀，与 util/workspace-path 的语法一致。 */
const FILE_PREFIX = 'dsh-resource://file/session/'

/** 别名字符集，与 host 端 splitAliasPath 的 ALIAS_RE 一致。 */
const ALIAS_RE = /^[A-Za-z0-9._-]+$/

/** 单字母别名排除：Windows 盘符 C 与 D 也长这样，本地路径不能被抢。 */
const SINGLE_LETTER_RE = /^[A-Za-z]$/

/** Windows 盘符绝对路径：远端是 Windows 时路径以盘符开头，正斜杠与反斜杠都认。 */
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/

/** 一个被认领的远程文件地址。 */
export interface RemoteTarget {
  /** 原始资源地址。 */
  address: string
  /** ssh 别名，取自 ~/.ssh/config。 */
  alias: string
  /** 远端绝对路径或 ~ 开头路径。 */
  rawPath: string
  /** 复原成 host 端认识的形式，即「别名:路径」。 */
  target: string
}

/**
 * 从 dsh-resource 文件地址里解析远程目标。
 * 只认 session 作用域，absolute 作用域没有授权会话，也被 host 拒绝。
 * @param address - 资源地址。
 */
export function parseRemoteAddress(address: string): RemoteTarget | null {
  if (!address.startsWith(FILE_PREFIX)) return null
  const rest = address.slice(FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  let path: string
  try {
    path = rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  const colon = path.indexOf(':')
  if (colon <= 0) return null
  const alias = path.slice(0, colon)
  const rawPath = path.slice(colon + 1)
  if (!ALIAS_RE.test(alias) || SINGLE_LETTER_RE.test(alias)) return null
  if (!(rawPath.startsWith('/') || rawPath.startsWith('~/') || WIN_ABS_RE.test(rawPath))) return null
  return { address, alias, rawPath, target: alias + ':' + rawPath }
}

/**
 * 取路径最后一段，作为 tab 标题，与内置预览器的 basename 一致。
 * 正斜杠与反斜杠都算分隔符，Windows 远端路径同样只显示文件名。
 * @param path - 远端路径。
 */
export function basenameOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name === '' ? path : name
}
