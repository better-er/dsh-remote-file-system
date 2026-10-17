/**
 * 浏览器全局声明：DSH 客户端模块加载器。
 * 只声明本插件实际用到的最小面。
 */

declare global {
  interface Window {
    /** DSH 客户端模块表：客户端插件经它注册。 */
    __ModuleLoader__: {
      load(entry: {
        id: string
        factory: (require: (id: string) => unknown) => unknown
      }): void
    }
  }
}

export {}
