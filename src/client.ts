/**
 * dsh-remote-file-system 客户端半身。
 *
 * 内置右侧栏的 text 类型只认主机本地文件：点开 wsl:~/x.md 这类远程路径时，
 * openFile 固定用 fileAddressFor 造出 dsh-resource://file/session/<id>/wsl:~/x.md，
 * 内置查看器经 ctx.fs 在本地查找而失败。
 *
 * 本类型以 extension 优先级认领这些伪 file 地址，从地址里解析出别名与远端路径，
 * 经 Host 自注册的 /remote-file-system 通道读取远端文本并渲染。
 * 只读：写入仍走 read_remote、write_remote、edit_remote 三条工具。
 *
 * @module dsh-remote-file-system/client
 */

import * as React from 'react'

// 常量

/** 本插件在 tab 注册表里的类型身份，同时用作正文席位 key。 */
const TYPE_ID = 'dsh-remote-file-system'

/** tab 类型的判别名。内置已有 guide、text、files、browser、subagentchat。 */
const KIND = 'remote'

/** 会话文件资源地址前缀，与 util/workspace-path 的语法一致。 */
const FILE_PREFIX = 'dsh-resource://file/session/'

/** 别名字符集，与 host 端 splitAliasPath 的 ALIAS_RE 一致。 */
const ALIAS_RE = /^[A-Za-z0-9._-]+$/

/** 单字母别名排除：Windows 盘符 C 与 D 也长这样，本地路径不能被抢。 */
const SINGLE_LETTER_RE = /^[A-Za-z]$/

/** 正文最多渲染的行数，超出提示，避免超大文件卡住浏览器。 */
const MAX_RENDER_LINES = 5000

// 地址解析

/** 一个被认领的远程文件地址。 */
interface RemoteTarget {
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
function parseRemoteAddress(address: string): RemoteTarget | null {
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
  if (!(rawPath.startsWith('/') || rawPath.startsWith('~/'))) return null
  return { address, alias, rawPath, target: alias + ':' + rawPath }
}

// Host 服务面

/** 右侧栏导航控制器最小面。 */
interface SidebarRightService {
  openResource(address: string, options?: { kind?: string; replaceTab?: string; revealIfOpened?: boolean; params?: unknown }): void
  active(): { id?: string; contentId?: string } | undefined
}

/** 右侧栏 tab 类型注册表最小面。 */
interface TabsService {
  register(definition: {
    id: string
    kind: string
    patterns?: string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?(address: string): boolean
    title(address: string): string
    keepMounted?: boolean
  }): () => void
}

/** 槽位服务最小面：keyed 席位按注册项 key 定址。 */
interface SlotsService {
  inject(name: string, callback: () => (() => void) | void): void
  register<P>(
    options: { name: string; id?: string; key?: string; order?: number; priority?: number },
    component: (props: P) => React.ReactElement,
  ): () => void
}

/** 客户端插件上下文最小面。 */
interface ClientContext {
  get(service: string): unknown
  effect(callback: () => (() => void) | void): void
}

/** 框架注入正文组件的 tab 信息钩子，由 slot 声明里的 hooks.tabInfo 转换为 useTabInfo。 */
interface TabBodyProps {
  useTabInfo(): {
    tab: {
      id: string
      navigation: { address: string; params?: { line?: number } }
      signal: AbortSignal
    }
  }
}

// RPC 调用

let rpcIdCounter = 0

/**
 * 调用 Host 端 RPC 端点。
 * 格式：POST /remote-file-system/<method>，独立 RPC 通道，
 * 遵循 DSH 四象限消息模型：body.method 必须等于 URL 中的端点名。
 * @param method - 端点名。
 * @param payload - 端点载荷。
 * @param signal - tab 记录消失时中止请求的取消信号。
 */
async function rpcCall<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const rpcId = 'rfs-' + String(++rpcIdCounter)
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: rpcId,
    method: method,
    payload: payload,
  })
  const res = await fetch('/remote-file-system/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const envelope = await res.json() as {
    result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
  }
  if (envelope.result && envelope.result.ok) return envelope.result.value as T
  const errMsg = envelope.result && envelope.result.error
    ? envelope.result.error.message
    : 'RPC 调用失败'
  throw new Error(errMsg)
}

/** read 端点的返回值。 */
interface ReadResult {
  path: string
  text: string
  bytes: number
  truncated: boolean
}

// 样式注入

/** 正文根节点撑满侧栏 tab 容器，工具栏固定、正文滚动。 */
const CSS = [
  '.dsh-rfs-body{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1)}',
  '.dsh-rfs-toolbar{display:flex;align-items:center;gap:8px;flex:none;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
  '.dsh-rfs-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
  '.dsh-rfs-status{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
  '.dsh-rfs-action{flex:none;padding:2px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px}',
  '.dsh-rfs-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-rfs-action:disabled{opacity:.45;cursor:default}',
  '.dsh-rfs-scroll{flex:1;min-height:0;overflow:auto;font-family:\'Cascadia Code\',\'Fira Code\',Consolas,monospace;font-size:12px;line-height:18px;padding:4px 0}',
  '.dsh-rfs-line{display:flex;white-space:pre;min-height:18px}',
  '.dsh-rfs-line-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-rfs-ln{flex:none;width:52px;padding-right:10px;text-align:right;color:var(--dsw-alias-label-secondary);user-select:none}',
  '.dsh-rfs-text{flex:1;min-width:0}',
  '.dsh-rfs-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
  '.dsh-rfs-root{display:flex;flex-direction:column;width:100%;min-width:0}',
  '.dsh-rfs-row{position:relative;overflow:hidden;display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);transition:color 100ms ease}',
  '.dsh-rfs-row[data-expandable]{cursor:pointer}',
  '.dsh-rfs-row:hover{color:var(--dsw-alias-label-secondary)}',
  '.dsh-rfs-leading{position:relative;flex:none;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px;padding:0;border:none;background:none;color:inherit}',
  '.dsh-rfs-leading svg:not([data-state]){width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
  '.dsh-rfs-content{display:flex;align-items:center;flex:1 1 auto;min-width:0}',
  '.dsh-rfs-rowtitle{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit}',
  '.dsh-rfs-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}',
  '.dsh-rfs-summary{flex:1 1 auto;min-width:0;display:flex;align-items:center;overflow:hidden;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
  '.dsh-rfs-summarytext{flex:none;white-space:nowrap}',
  '.dsh-rfs-summarylink{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;padding:0;border:none;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
  '.dsh-rfs-summarylink:hover{text-decoration:underline;text-underline-offset:3px}',
  '.dsh-rfs-iocard{display:flex;flex-direction:column;margin:4px 0 4px 4px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}',
  '.dsh-rfs-iosection{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;align-items:baseline;padding:12px 16px;max-height:150px;overflow-y:auto}',
  '.dsh-rfs-iolabel{position:sticky;top:0;align-self:start;color:var(--dsw-alias-label-caption)}',
  '.dsh-rfs-iodivider{flex:none;height:0.5px;background:var(--dsw-alias-border-l2)}',
  '.dsh-rfs-iotext{min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}',
  '.dsh-rfs-iotext[data-error]{color:var(--dsw-alias-state-error-primary)}',
].join('\n')

/** 插件样式表元素，随插件生命周期存在。 */
let styleTag: HTMLStyleElement | null = null

/** 注入插件样式表，幂等。 */
function ensureStyle(): void {
  if (styleTag) return
  const tag = document.createElement('style')
  // 样式必须自带归属标记：client 模块系统在实例化插件时会认领页面上无 data-plugin 的 style，
  // 别的插件随后重载就按 id 把它们一起删掉，本插件样式随即失效。
  tag.dataset.plugin = 'dsh-remote-file-system'
  tag.dataset.pluginCss = 'dsh-remote-file-system/client.css'
  tag.textContent = CSS
  document.head.appendChild(tag)
  styleTag = tag
}

/** 移除插件样式表。 */
function removeStyle(): void {
  if (styleTag && styleTag.parentNode) {
    styleTag.parentNode.removeChild(styleTag)
  }
  styleTag = null
}

/** 把字节数格式化成可读文本。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

// 正文组件

/**
 * 一个 remote tab 的正文：读取远端文本、按行渲染、支持行号定位。
 * 地址解析失败或缺少服务时只渲染错误提示，不抛错崩溃。
 * @param props - 框架注入的 tab 信息钩子。
 */
function RemoteFileBody(props: TabBodyProps): React.ReactElement {
  const info = props.useTabInfo()
  const address = info.tab.navigation.address
  const params = info.tab.navigation.params
  const line = params && typeof params.line === 'number' ? params.line : undefined
  const target = parseRemoteAddress(address)

  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [text, setText] = React.useState('')
  const [bytes, setBytes] = React.useState(0)
  const [truncated, setTruncated] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  const [wrap, setWrap] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement | null>(null)

  // 读取内容：地址变化或手动刷新即重读。取消标记避免旧请求覆盖新 tab 的正文。
  React.useEffect(function () {
    if (!target) {
      setPhase('error')
      setMessage('无法识别的远程文件地址')
      return
    }
    let cancelled = false
    setPhase('loading')
    setMessage('')
    rpcCall<ReadResult>('read', { target: target.target }, info.tab.signal).then(function (result) {
      if (cancelled) return
      setText(result.text)
      setBytes(result.bytes)
      setTruncated(result.truncated)
      setPhase('ready')
    }).catch(function (e: unknown) {
      if (cancelled) return
      setPhase('error')
      setMessage(e instanceof Error ? e.message : String(e))
    })
    return function () { cancelled = true }
  }, [address, revision])

  // 内容就绪后按 navigation.params.line 把目标行滚到视野中央。
  React.useEffect(function () {
    if (phase !== 'ready' || line === undefined) return
    const body = bodyRef.current
    if (body === null) return
    const row = body.querySelector('[data-line="' + line + '"]')
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'center' })
  }, [phase, text, line])

  // 按行切分，去掉尾随换行产生的空行，再按上限截断并记录是否真的截断。
  const view = React.useMemo(function () {
    if (text === '') return { rows: [] as string[], capped: false }
    const parts = text.split('\n')
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    return { rows: parts.slice(0, MAX_RENDER_LINES), capped: parts.length > MAX_RENDER_LINES }
  }, [text])

  function refresh(): void { setRevision(function (r) { return r + 1 }) }

  const status = phase === 'ready'
    ? formatBytes(bytes) + (truncated ? ' · 已截断' : '') + (view.capped ? ' · 仅显示前 ' + MAX_RENDER_LINES + ' 行' : '')
    : message

  return React.createElement('div', { className: 'dsh-rfs-body' },
    React.createElement('div', { className: 'dsh-rfs-toolbar' },
      React.createElement('span', { className: 'dsh-rfs-title' }, target ? target.target : address),
      React.createElement('span', { className: 'dsh-rfs-status' }, status),
      React.createElement('button', {
        type: 'button',
        className: 'dsh-rfs-action',
        onClick: function () { setWrap(function (w) { return !w }) },
        title: '切换自动换行',
      }, wrap ? '不换行' : '换行'),
      React.createElement('button', {
        type: 'button',
        className: 'dsh-rfs-action',
        onClick: refresh,
        disabled: phase === 'loading',
        title: '重新读取',
      }, '刷新'),
    ),
    React.createElement('div', {
      ref: bodyRef,
      className: 'dsh-rfs-scroll',
      style: wrap ? { whiteSpace: 'pre-wrap' } : undefined,
    },
      phase === 'loading' ? React.createElement('div', { className: 'dsh-rfs-message' }, '加载中...') : null,
      phase === 'error' ? React.createElement('div', { className: 'dsh-rfs-message' }, '打开失败: ' + message) : null,
      phase === 'ready' && view.rows.length === 0 ? React.createElement('div', { className: 'dsh-rfs-message' }, '空文件') : null,
      phase === 'ready' ? view.rows.map(function (row, index) {
        const number = index + 1
        return React.createElement('div', {
          key: number,
          'data-line': String(number),
          className: line === number ? 'dsh-rfs-line dsh-rfs-line-active' : 'dsh-rfs-line',
        },
          React.createElement('span', { className: 'dsh-rfs-ln' }, String(number)),
          React.createElement('span', { className: 'dsh-rfs-text' }, row),
        )
      }) : null,
    ),
  )
}

// read_remote 工具卡

/** read_remote 工具卡的数据块，字段一律按未知收窄。 */
interface ReadRemoteBlock {
  kind?: unknown
  isError?: unknown
  argsRaw?: unknown
  call?: { argsRaw?: unknown } | undefined
  content?: unknown
  meta?: unknown
}

/** tool.call.toolview 的 owner 面，只取本卡用到的字段。 */
interface ToolViewProps {
  block: ReadRemoteBlock
  toolName?: string
  openFile?: (path: string) => void | Promise<void>
  inspect?: () => void
}

/**
 * 从参数里取远端路径。
 * running 的 argsRaw 在块顶层，settled 的挪到 block.call 上，两处兼容。
 * @param block - 工具卡数据块。
 */
function readRemotePath(block: ReadRemoteBlock): string | undefined {
  const settled = 'kind' in block
  const raw = settled ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const p = (parsed as Record<string, unknown>).file_path
      if (typeof p === 'string' && p !== '') return p
    }
  } catch {
    // 参数尚未就绪时不报错，等下一帧。
  }
  return undefined
}

/** 取工具结果里的文本，供展开的输入输出卡渲染。 */
function readRemoteText(block: ReadRemoteBlock): string | null {
  const content = Array.isArray(block.content) ? block.content : []
  for (const item of content) {
    if (item !== null && typeof item === 'object') {
      const record = item as { type?: unknown; text?: unknown }
      if (record.type === 'text' && typeof record.text === 'string') return record.text
    }
  }
  return null
}

/** 取格式化后的调用参数，解析失败时原样返回。 */
function readRemoteInput(block: ReadRemoteBlock): string | null {
  const settled = 'kind' in block
  const raw = settled ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * read_remote 的工具卡。
 *
 * 内置 read 卡按工具名 read 注册，read_remote 没有对应条目而走通用行，卡里没有打开文件的入口，
 * 因此这里接管它，给出可点击的远端路径，经 owner 的 openFile 在右侧栏打开 remote tab。
 * 点击行头展开结果文本，输入与输出仍可回看。
 * @param props - 框架注入的工具卡 owner 面。
 */
function ReadRemoteRow(props: ToolViewProps): React.ReactElement {
  const block = props.block
  const filePath = readRemotePath(block)
  const settled = 'kind' in block
  const failed = settled && block.isError === true
  const [open, setOpen] = React.useState(false)
  const input = readRemoteInput(block)
  const output = settled ? readRemoteText(block) : null
  const expandable = input !== null || output !== null
  const canOpen = filePath !== undefined && props.openFile !== undefined && !failed
  function onOpenFile(event: React.MouseEvent): void {
    event.stopPropagation()
    if (filePath === undefined || props.openFile === undefined) return
    const opened = props.openFile(filePath)
    if (opened instanceof Promise) opened.catch(function (e: unknown) {
      console.error('[remote-file-system] 打开远端文件失败', e)
    })
  }
  function onToggle(): void { setOpen(function (v) { return !v }) }
  // 与内置工具行同源的展开指示箭头。
  const icon = React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
  }, React.createElement('path', {
    d: 'M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10',
    stroke: 'currentColor',
  }))
  return React.createElement('div', { className: 'dsh-rfs-root' },
    React.createElement('div', {
      className: 'dsh-rfs-row',
      'data-disclosure-row': true,
      'data-expandable': expandable ? true : undefined,
      role: expandable ? 'button' : undefined,
      tabIndex: expandable ? 0 : undefined,
      'aria-expanded': expandable ? open : undefined,
      onClick: expandable ? onToggle : undefined,
    },
      React.createElement('span', { className: 'dsh-rfs-leading' }, icon),
      React.createElement('span', { className: 'dsh-rfs-content' },
        React.createElement('span', { className: 'dsh-rfs-rowtitle' }, '工具调用'),
        React.createElement('span', { className: 'dsh-rfs-sep', 'data-shimmer-decoration': 'true', 'aria-hidden': true }),
        React.createElement('span', { className: 'dsh-rfs-summary' },
          React.createElement('span', { className: 'dsh-rfs-summarytext' }, filePath !== undefined ? 'read_remote · ' : 'read_remote'),
          filePath !== undefined
            ? (canOpen
                ? React.createElement('button', { type: 'button', className: 'dsh-rfs-summarylink', onClick: onOpenFile }, filePath)
                : React.createElement('span', { className: 'dsh-rfs-summarylink' }, filePath))
            : null,
        ),
      ),
    ),
    expandable && open ? React.createElement('div', { className: 'dsh-rfs-iocard' },
      input !== null ? React.createElement('div', { className: 'dsh-rfs-iosection' },
        React.createElement('span', { className: 'dsh-rfs-iolabel' }, '输入'),
        React.createElement('span', { className: 'dsh-rfs-iotext' }, input),
      ) : null,
      input !== null && output !== null ? React.createElement('span', { className: 'dsh-rfs-iodivider', 'aria-hidden': true }) : null,
      output !== null ? React.createElement('div', { className: 'dsh-rfs-iosection' },
        React.createElement('span', { className: 'dsh-rfs-iolabel' }, '输出'),
        React.createElement('span', { className: 'dsh-rfs-iotext', ...(failed ? { 'data-error': true } : {}) }, output),
      ) : null,
    ) : null,
  )
}

// 插件入口

/** 插件名，与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-remote-file-system'

/** 依赖的客户端服务：右侧栏 tab 注册表与槽位。 */
export const inject: string[] = ['slots', 'sidebarRightTabs', 'sidebarRight']

/**
 * 客户端 apply：注册 remote tab 类型与它的正文。
 *
 * 类型以 extension 优先级压过内置 text 的 fallback，但只认领能解析出远程别名的会话地址，
 * 本地文件仍由内置查看器处理。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  if (!slots) return
  const tabs = ctx.get('sidebarRightTabs') as TabsService | undefined
  if (!tabs) throw new Error('[remote-file-system] 缺少 sidebarRightTabs 服务，请确认 dsh-client-ui-sidebar-right 已加载')
  const right = ctx.get('sidebarRight') as SidebarRightService | undefined
  if (!right) throw new Error('[remote-file-system] 缺少 sidebarRight 服务，请确认 dsh-client-ui-sidebar-right 已加载')

  ctx.effect(function () {
    ensureStyle()
    return function () { removeStyle() }
  })

  ctx.effect(function () {
    return tabs.register({
      id: TYPE_ID,
      kind: KIND,
      priority: 'extension',
      patterns: ['dsh-resource://file/**'],
      canOpen: function (address) { return parseRemoteAddress(address) !== null },
      title: function (address) {
        const parsed = parseRemoteAddress(address)
        return parsed ? parsed.target : address
      },
      keepMounted: true,
    })
  })

  slots.inject('sidebar.right.pane.tab', function () {
    return slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, RemoteFileBody)
  })

  // read_remote 的工具卡原本没有打开文件的入口，接管它并给出可点击路径。
  slots.inject('tool.call.toolview', function () {
    return slots.register({ name: 'tool.call.toolview', key: 'read_remote', priority: 0 }, ReadRemoteRow)
  })
}

const plugin = { name, inject, apply }
export default plugin
