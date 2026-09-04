/**
 * dsh-remote-file-system — host 半身入口。
 *
 * 职责：实例化 RemoteFileSystem 即 ssh 后端，注册 read_remote、write_remote、edit_remote 三个模型可见工具，并为各工具注册等价的 systemPrompt 引导节。
 *
 * 加载形态：组合包 bundle，cordis.patch.yml 插进 profile。官方 @deepseek-ai/* 依赖保持 external，与 host 共享同一份 cordis 与 dsh-fs 实例。
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteFileSystem } from './remote-fs.ts'
import { createReadRemoteTool } from './read.ts'
import { createWriteRemoteTool } from './write.ts'
import { createEditRemoteTool } from './edit.ts'

/** 插件名，与 cordis.patch.yml 的 name 一致，loader 诊断用。 */
export const name = 'dsh-remote-file-system'

/** 必需宿主服务：tools 工具注册表与 systemPrompt 引导。 */
export const inject = ['tools', 'systemPrompt']

/** 插件配置：enabled 总开关。 */
export interface Config {
  /** 是否注册远程工具。默认 true。 */
  enabled?: boolean
}

/**
 * 插件 apply：实例化 RemoteFileSystem，注册三工具并加 systemPrompt 引导节。
 * 三个工具的引导节复用原生 read、write、edit 的顺序位，节名唯一避免冲突。
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return

  // 构造一次后端实例，三工具共享。普通对象，不注册为 ctx.fs，无副作用。
  const fs = new RemoteFileSystem()

  // systemPrompt：为远程工具注册与原生 read、write、edit 等价的使用引导。
  ctx.systemPrompt.section({
    name: 'tool:read_remote',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: 'Use read_remote (not shell commands) to inspect UTF-8 text files on remote hosts over ssh. file_path carries the target as alias:path (e.g. wsl:~/x.md). Results include line numbers; use offset and limit to continue reading large files.',
  })
  ctx.systemPrompt.section({
    name: 'tool:write_remote',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WRITE'),
    text: 'Use write_remote to create a NEW UTF-8 text file on a remote host. It only creates — the target must not already exist, and it never overwrites.',
  })
  ctx.systemPrompt.section({
    name: 'tool:edit_remote',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: 'Use edit_remote for targeted literal changes to an existing remote text file. It replaces literal old_string with new_string; by default old_string must appear exactly once.',
  })

  // 注册三个工具。defineTool 纯函数返回对象，ctx.tools.register 副作用注册。
  ctx.tools.register(createReadRemoteTool(fs))
  ctx.tools.register(createWriteRemoteTool(fs))
  ctx.tools.register(createEditRemoteTool(fs))
}