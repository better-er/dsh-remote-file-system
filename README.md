# dsh-remote-file-system

模型可见的远程文件工具 read_remote、write_remote、edit_remote，经 ssh 读写远程主机文件。标准可安装的 dsh host 插件。

## 引言

DSH 只有本地文件系统的读写能力，而读写远程文件只能用 PowerShell 再套 bash 的 ssh 命令，非常容易出错。这个插件提供了三条可在模型中直接调用的远程文件工具，读写远程文件无需再套 ssh 命令。并将兼容 [dsh-edit-diff](https://github.com/better-er/dsh-edit-diff) 和 [dsh-write-rule-guard](https://github.com/better-er/dsh-write-rule-guard) 的优化显示与规则检查。

## 能力

| 工具 | 作用 | 关键语义 |
| --- | --- | --- |
| read_remote | 读远端 UTF-8 文本，行号分页 | offset、limit、totalLines，与原生 read 一致 |
| write_remote | 远端新建文件 | 只允许新建，目标已存在即拒绝，绝无覆写分支 |
| edit_remote | 远端字面替换 | 唯一匹配，多现拒绝，未命中报错；支持 replace_all |

## file_path 写法

ssh 目标与远程路径合在一个 file_path 字段，沿用「别名:路径」前缀，别名取自 ~/.ssh/config：

```
wsl:~/x.md
myserver:/etc/hosts
```

只收绝对路径或 ~/ 开头；裸相对路径直接拒绝。

## 安装

**从 GitHub 安装**：源码在 `src/`，`lib/` 不入仓库，安装时 npm 会触发 `prepare` 脚本现场构建。

```powershell
dsh plugin --profile web add github:better-er/dsh-remote-file-system
```

**从 npm 安装**：包内已含构建产物 `lib/index.js`，安装时不再构建。

```powershell
dsh plugin --profile web add dsh-remote-file-system
```

两种方式装完都会自动挂载，重启 DSH web 后启用，无需手工编辑任何文件。

## 卸载

```powershell
dsh plugin --profile web remove dsh-remote-file-system
```

彻底移除，重启 DSH web 后不再加载。

## 后端

文件后端 RemoteFileSystem 刻意不继承 @deepseek-ai/dsh-fs 的 FileSystem 与 cordis Service，避免「继承即注册」污染会话 ctx.fs；只借用 dsh-fs 类型词表与 FsError。字节经 base64 再经 ssh 传输。

## 开发

```
pnpm install      # 装依赖，含 devDeps 类型与 esbuild
pnpm run build    # esbuild 打包 host 半身到 lib/
pnpm run typecheck
node smoke/verify.mjs   # 手动组装最小 cordis 组合，对 wsl 冒烟三工具
```

## 依赖与构建注意

@deepseek-ai/dsh-fs、dsh-tools、dsh-system-prompt 版本 0.1.2-rc.1，@deepseek-ai/cordis 版本 4.0.2。构建必须把这些包 external，与 host 共享单一 cordis 与 dsh-fs 实例；否则双原型会让 instanceof FsError 与 Service 标识错位。