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
 * 正文沿用内置文档预览的外观：纯文本按源码行渲染，代码文件交给共享的 CodeBlock，
 * 头部是同样 38px 的路径栏与换行、重新加载图标按钮。
 *
 * @module dsh-remote-file-system/client
 */

import * as React from 'react'
import {
  CodeBlock,
  FileTypeIcon,
  IconNowrapFillRegular,
  IconRefreshOutlineRegular,
  IconWrapFillRegular,
  Menu,
  PathLabel,
  StateDot,
  Tooltip,
  classifyFileType,
  languageForPath,
} from '@deepseek-ai/dsh-client-ui-primitives'

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

/** 框架交给正文与标题的 tab 信息，由 slot 声明里的 hooks.tabInfo 转换为 useTabInfo。 */
interface RemoteTabInfo {
  tab: {
    id: string
    title: string
    navigation: { address: string; params?: { line?: number } }
    signal: AbortSignal
  }
}

/** 正文组件的注入面。 */
interface TabBodyProps {
  useTabInfo(): RemoteTabInfo
}

/** tab 标题组件的注入面。 */
interface TabTitleProps {
  useTabInfo(): RemoteTabInfo
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

/** 预览外观对齐内置文档预览：38px 头部、13px 等宽正文与同一组图标按钮。 */
const CSS = [
  '.dsh-rfs-preview{flex-direction:column;flex:auto;height:100%;min-height:0;display:flex}',
  '.dsh-rfs-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 16px;display:flex}',
  '.dsh-rfs-path{margin-right:12px}',
  '.dsh-rfs-titleIcon{flex:none}',
  '.dsh-rfs-notice{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;align-items:center;gap:10px;margin:0;padding:6px 10px;font-size:12px;display:flex}',
  '.dsh-rfs-body{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);font-family:var(--dsw-font-mono,ui-monospace,monospace);white-space:pre;flex:auto;margin:0;padding:0;line-height:1.6;position:relative;overflow:auto}',
  '.dsh-rfs-body::-webkit-scrollbar-track{margin:2px}',
  '.dsh-rfs-body[data-code]{flex-direction:column;display:flex;overflow:hidden}',
  '.dsh-rfs-wrap{white-space:pre-wrap;word-break:break-word}',
  '.dsh-rfs-textDocument{box-sizing:border-box;min-width:100%;min-height:100%;padding:8px}',
  '.dsh-rfs-page{font:var(--dsw-font-markdown-code-block);white-space:inherit;margin:0}',
  '.dsh-rfs-line{padding:0 10px}',
  '.dsh-rfs-lineTarget{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-rfs-empty{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);font-family:var(--dsw-font-family);text-align:center;white-space:normal;flex-direction:column;justify-content:center;align-items:center;gap:16px;padding:0 24px;line-height:1.6;display:flex}',
  '.dsh-rfs-empty:after{content:"";flex:0 12%}',
  '.dsh-rfs-emptyIcon{opacity:.6;filter:grayscale();flex:none}',
  '.dsh-rfs-emptyLine{margin:0}',
  '.dsh-rfs-retry{height:32px;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);cursor:pointer;background:0 0;flex:none;align-items:center;gap:6px;padding:0 14px 0 12px;font-family:inherit;display:inline-flex}',
  '.dsh-rfs-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-rfs-status{box-sizing:border-box;flex-direction:column;justify-content:center;align-items:center;gap:8px;height:100%;padding:12px 10px;display:flex}',
  '.dsh-rfs-statusLine{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);white-space:normal;align-items:center;gap:10px;margin:0;padding:6px 10px;line-height:1.6;display:flex}',
  '.dsh-rfs-tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:6px;line-height:1;display:inline-flex}',
  '.dsh-rfs-tool svg{width:15px;height:15px}',
  '.dsh-rfs-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-rfs-viewerTool{width:auto;max-width:160px;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;flex:none;padding:0 6px;font-size:12px;overflow:hidden}',
  '.dsh-rfs-code{white-space:normal;flex-direction:column;flex:auto;width:100%;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden}',
  '.dsh-rfs-code .dsh-rfs-codeblock{--dsl-code-block-border-radius:0px;--dsl-code-block-line-white-space:pre;--dsl-code-block-background:transparent;flex-direction:column;flex:auto;min-width:0;height:100%;min-height:0;margin:0;display:flex;position:static}',
  '.dsh-rfs-code .dsh-rfs-codeblock>[data-code-block-content]{flex:auto;min-width:0;min-height:0;display:block;position:relative;overflow:auto}',
  '.dsh-rfs-code .dsh-rfs-codeblock>[data-code-block-content]::-webkit-scrollbar-track{margin:2px}',
  '.dsh-rfs-code .dsh-rfs-codeblock pre{box-sizing:border-box;white-space:pre;word-break:normal;overflow-wrap:normal;min-width:100%;padding:16px;overflow:visible}',
  '.dsh-rfs-code[data-wrap=true] .dsh-rfs-codeblock{--dsl-code-block-line-white-space:pre-wrap}',
  '.dsh-rfs-code[data-wrap=true] .dsh-rfs-codeblock pre{white-space:pre-wrap;overflow-wrap:anywhere}',
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

/** 内置预览器视为文档、不走代码渲染的语言。 */
const DOCUMENT_LANGUAGES = new Set(['markdown', 'mdx', 'rst', 'latex', 'bibtex', 'asciidoc'])

/**
 * 按远端路径选择内置预览器会用的代码语言。
 * 文档类语言仍按纯文本展示，与内置 Markdown 渲染器的分工一致。
 * @param path - 远端路径。
 * @returns 代码高亮语言，纯文本时为 null。
 */
function codeLanguageOf(path: string): string | null {
  const language = languageForPath(path)
  if (language === undefined || DOCUMENT_LANGUAGES.has(language)) return null
  return language
}

/** 取路径最后一段，作为 tab 标题，与内置预览器的 basename 一致。 */
function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name === '' ? path : name
}

// 正文组件

/**
 * 一个 remote tab 的正文：读取远端文本，按内置文档预览的两种形态渲染。
 * 代码文件交给共享的 CodeBlock，纯文本按源码行渲染。
 * 地址解析失败或读取失败时只渲染原生样式的空态，不抛错崩溃。
 * @param props - 框架注入的 tab 信息钩子。
 */
function RemoteFileBody(props: TabBodyProps): React.ReactElement {
  const info = props.useTabInfo()
  const address = info.tab.navigation.address
  const params = info.tab.navigation.params
  const line = params && typeof params.line === 'number' ? params.line : undefined
  const target = React.useMemo(function () { return parseRemoteAddress(address) }, [address])
  const language = React.useMemo(function () { return target ? codeLanguageOf(target.rawPath) : null }, [target])

  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [text, setText] = React.useState('')
  const [truncated, setTruncated] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  const [wrap, setWrap] = React.useState(true)
  // 代码文件与内置预览一样可在「代码」与「纯文本」之间切换；documents 只有一个渲染器时不显示菜单。
  const [plain, setPlain] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const showCode = language !== null && !plain
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
      setTruncated(result.truncated)
      setPhase('ready')
    }).catch(function (e: unknown) {
      if (cancelled) return
      setPhase('error')
      setMessage(e instanceof Error ? e.message : String(e))
    })
    return function () { cancelled = true }
  }, [address, revision])

  // 内容就绪后按 navigation.params.line 定位：与内置预览一样直接写滚动容器的 scrollTop。
  React.useEffect(function () {
    if (phase !== 'ready' || line === undefined) return
    const body = bodyRef.current
    if (body === null) return
    const scroller = showCode ? body.querySelector('[data-code-block-content]') : body
    if (!(scroller instanceof HTMLElement)) return
    const row = showCode
      ? body.querySelectorAll('.dsh-rfs-codeblock pre .line').item(line - 1)
      : body.querySelector('[data-line="' + line + '"]')
    if (row instanceof HTMLElement) scroller.scrollTop = Math.max(0, row.offsetTop)
  }, [phase, text, line, showCode])

  // 按行切分，去掉尾随换行产生的空行，再按上限截断并记录是否真的截断。
  const view = React.useMemo(function () {
    if (text === '') return { rows: [] as string[], capped: false }
    const parts = text.split('\n')
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    return { rows: parts.slice(0, MAX_RENDER_LINES), capped: parts.length > MAX_RENDER_LINES }
  }, [text])

  function refresh(): void { setRevision(function (r) { return r + 1 }) }

  const notice = phase === 'ready' && (truncated || view.capped)
    ? (view.capped ? '仅显示前 ' + MAX_RENDER_LINES + ' 行' : '文件较大，已截断')
    : null

  const body = React.createElement('div', {
    ref: bodyRef,
    className: wrap ? 'dsh-rfs-body dsh-rfs-wrap' : 'dsh-rfs-body',
    ...(showCode ? { 'data-code': true } : {}),
  },
    phase === 'loading' ? React.createElement('div', { className: 'dsh-rfs-status' },
      React.createElement(StateDot, { state: 'ongoing', size: 28 }),
      React.createElement('p', { className: 'dsh-rfs-statusLine' }, '文档渲染中...'),
    ) : null,
    phase === 'error' ? React.createElement('div', { className: 'dsh-rfs-empty' },
      React.createElement(FileTypeIcon, {
        kind: classifyFileType(target ? target.rawPath : ''),
        size: 36,
        className: 'dsh-rfs-emptyIcon',
      }),
      React.createElement('p', { className: 'dsh-rfs-emptyLine' }, message),
      React.createElement('button', { type: 'button', className: 'dsh-rfs-retry', onClick: refresh },
        React.createElement(IconRefreshOutlineRegular, { size: 14 }),
        '重试',
      ),
    ) : null,
    phase === 'ready' && showCode ? React.createElement('div', {
      className: 'dsh-rfs-code',
      'data-code-preview': true,
      'data-wrap': wrap,
    },
      React.createElement(CodeBlock, {
        className: 'dsh-rfs-codeblock',
        code: view.rows.join('\n'),
        lang: language,
        streaming: false,
        lineNumbers: true,
        wrap,
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码',
          wrapLabel: '启用自动换行',
          unwrapLabel: '关闭自动换行',
        },
      }),
    ) : null,
    phase === 'ready' && !showCode ? React.createElement('div', {
      className: 'dsh-rfs-textDocument',
      'data-textpreview-plain': true,
    },
      React.createElement('pre', { className: 'dsh-rfs-page' },
        view.rows.map(function (row, index) {
          const number = index + 1
          return React.createElement('div', {
            key: number,
            'data-line': String(number),
            className: line === number ? 'dsh-rfs-line dsh-rfs-lineTarget' : 'dsh-rfs-line',
          }, row, '\n')
        }),
      ),
    ) : null,
  )

  return React.createElement('div', { className: 'dsh-rfs-preview' },
    notice !== null ? React.createElement('p', { className: 'dsh-rfs-notice' },
      React.createElement('span', null, notice),
    ) : null,
    React.createElement('div', { className: 'dsh-rfs-header' },
      React.createElement(PathLabel, {
        path: target ? target.target : address,
        className: 'dsh-rfs-path',
      }),
      language !== null ? React.createElement(Menu, {
        open: menuOpen,
        anchor: React.createElement('button', {
          type: 'button',
          className: 'dsh-rfs-tool dsh-rfs-viewerTool',
          'aria-label': '打开方式',
          title: plain ? '纯文本' : '代码',
          'data-document-viewer-menu': true,
          onClick: function () { setMenuOpen(function (v) { return !v }) },
        }, plain ? '纯文本' : '代码'),
        items: [
          { id: 'code', label: '代码' },
          { id: 'plain', label: '纯文本' },
        ],
        selectedId: plain ? 'plain' : 'code',
        onSelect: function (id: string) {
          setPlain(id === 'plain')
          setMenuOpen(false)
        },
        onClose: function () { setMenuOpen(false) },
        align: 'end',
        portal: true,
        dense: true,
      }) : null,
      React.createElement(Tooltip, {
        label: wrap ? '关闭自动换行' : '启用自动换行',
        side: 'bottom',
        delayMs: 500,
        children: React.createElement('button', {
          type: 'button',
          className: 'dsh-rfs-tool',
          'aria-pressed': wrap,
          'aria-label': '自动换行',
          onClick: function () { setWrap(function (w) { return !w }) },
        }, wrap ? React.createElement(IconNowrapFillRegular, {}) : React.createElement(IconWrapFillRegular, {})),
      }),
      React.createElement(Tooltip, {
        label: '重新加载',
        side: 'bottom',
        delayMs: 500,
        children: React.createElement('button', {
          type: 'button',
          className: 'dsh-rfs-tool',
          'aria-label': '重新加载',
          onClick: refresh,
        }, React.createElement(IconRefreshOutlineRegular, {})),
      })
    ),
    body,
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

// tab 标题

/**
 * tab 条上的标题：文件类型图标加文件名，与内置文档预览的 TextTitle 同构。
 * @param props - 框架注入的 tab 信息钩子。
 */
function RemoteFileTitle(props: TabTitleProps): React.ReactElement {
  const info = props.useTabInfo()
  return React.createElement(React.Fragment, null,
    React.createElement(FileTypeIcon, {
      kind: classifyFileType(info.tab.title),
      size: 16,
      className: 'dsh-rfs-titleIcon',
    }),
    info.tab.title,
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
        return parsed ? basenameOf(parsed.rawPath) : address
      },
      keepMounted: true,
    })
  })

  slots.inject('sidebar.right.pane.tab', function () {
    return slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, RemoteFileBody)
  })

  slots.inject('sidebar.right.pane.tab.title', function () {
    return slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, RemoteFileTitle)
  })

  // read_remote 的工具卡原本没有打开文件的入口，接管它并给出可点击路径。
  slots.inject('tool.call.toolview', function () {
    return slots.register({ name: 'tool.call.toolview', key: 'read_remote', priority: 0 }, ReadRemoteRow)
  })
}

const plugin = { name, inject, apply }
export default plugin
