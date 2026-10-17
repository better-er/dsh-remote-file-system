/**
 * 构建脚本：esbuild 打包 host 半身。
 *
 * host 半身 src/index.ts 引用 @deepseek-ai/* 官方包，即 defineTool、FsError、cordis Context。
 * 这些必须保持 external。
 * 插件被 dsh host 加载时，与 host 共享同一份 cordis 与 dsh-fs 实例；若打进 bundle 会产生第二份原型，defineTool 产物的 instanceof FsError 与 Service 标识都会错位。
 * 因此官方包一律不 bundle，运行时由 profile 与 host 的 node_modules 解析。
 *
 * client 半身 src/client.ts 由浏览器加载，套上 DSH 客户端模块加载器的包装：
 * 顶层调用 window.__ModuleLoader__.load，factory 接收宿主的 require；react 由宿主模块表提供，必须 external。
 *
 * 前置：pnpm install 拉 esbuild 到 ./node_modules。
 */
import { build, context } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const watch = process.argv.includes('--watch')

/** 让 esbuild 从本插件 node_modules 解析依赖。 */
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))]

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
  // 官方包由 host 运行时提供，不能打进 bundle，见文件头说明
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ],
  // 保留 UTF-8 源码字符，默认 ascii 会把中文注释与字符串转成 unicode 转义，产物难读
  charset: 'utf8',
}

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  sourcemap: true,
  logLevel: 'info',
  // 宿主模块表提供 react 与 primitives，不能打进 bundle，否则图标与主题样式会成为第二份实现
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  charset: 'utf8',
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-remote-file-system", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
}

await mkdir('lib', { recursive: true })
if (watch) {
  const hostCtx = await context(hostOptions)
  const clientCtx = await context(clientOptions)
  await Promise.all([hostCtx.watch(), clientCtx.watch()])
  console.log('[build] watching src/index.ts and src/client.ts ...')
} else {
  await build(hostOptions)
  await build(clientOptions)
}
