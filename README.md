# dsh-github-sync

**用 GitHub 私有仓库在多台机器之间同步 dsh 会话、插件清单与设置。**

每个 dsh 实例在仓库里拥有自己的目录（`instances/<实例ID>/…`），互不重叠——所以两台机器永远不会争抢同一个文件，同步不需要合并、不会静默覆盖：

```
instances/
  laptop-a-7f3c/
    manifest.json                     这台机器的清单（主机名/分组/统计/工作区）
    sessions/<工作区目录名>/<会话ID>/session[.vN].jsonl.zstd
    plugins/<profile>/{package.json,cordis.patch.yml,pnpm-lock.yaml,pnpm-workspace.yaml}
    settings/settings.yaml            可选，默认关闭
  desktop-2a91/
    …
```

## 与参考实现（[weibaohui/dsh-sync](https://github.com/weibaohui/dsh-sync)）的差异

参考实现以 GitCode 为目标、用 git 二进制 + 影子工作树 + 分支/PR/冲突处理。这个插件面向 **GitHub**，并做了几处不同的取舍：

| | 本插件 | 说明 |
|---|---|---|
| 传输 | **纯 GitHub REST API**（全局 `fetch`） | 不需要 `git` 二进制；token 不会落进 `.git/config`；沙箱/无 git 的机器也能用；走 dsh 启动器已装好的代理策略 |
| 冲突 | **结构上不存在** | 每台机器只写自己的 `instances/<ID>/`，没有共同文件可争 |
| 增量 | **内容寻址** | 本地算 `sha1("blob <len>\0" + bytes)`，与远端树里的 blob sha 比对，未变的会话不重复上传 |
| PR | 可选 | `pullRequest` 打开后走「分支 → PR → 可合并则 squash 合并」，冲突则把 PR 留在仓库里 |
| 清单时标 | 不含时间戳 | manifest 对相同输入是确定性的，否则每次定时同步都会产生一个空提交；「何时备份」由 GitHub 的提交时间承担 |

## 安装

```bash
dsh plugin --profile web add dsh-github-sync -w
```

装完重启 `dsh web` 生效。本地开发时可以装路径：

```bash
dsh plugin --profile web add "file:D:\path\to\dsh-github-sync"
```

## 使用

1. 在 GitHub 建一个**私有**仓库（插件不代建）。公共仓库会被直接拒绝：会话日志里含本机绝对路径，清单里可能有你的配置。
2. 建一个 **fine-grained PAT**，只授权这个仓库，权限勾 `Contents: Read and write`（要用 PR 模式再加 `Pull requests: Read and write`）。
3. 打开 Web UI → **设置 → GitHub 同步**，填仓库（`owner/repo` 或完整 URL）、分支、令牌，保存。
4. 点「验证仓库」确认可写且为私有，再点「立即备份」。
5. 在另一台机器上装同一个插件、填同一个仓库，就能在「会话备份」页看到别的机器推上来的内容并一键恢复。

定时自动备份在「概览 → 自动备份」里开启；`autoSync` 打开后按 `intervalMinutes`（最小 5 分钟）执行，可选启动时备份一次。

## 同步内容

三类内容各自独立开关，关掉的那一类既不上传、也不会删除云端已有内容：

| 分组 | 默认 | 内容 | 排除 |
|---|---|---|---|
| `sessions` | 开 | `$DSH_HOME/sessions/**` 整目录 | `*.tmp`、`session.lock`、`.dsh-mkdir*` |
| `plugins` | 开 | 各 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | `node_modules/`、`cordis.yml`（启动器每次覆写）、`.dsh-market/`、`.dsh-module-fallback/` |
| `settings` | **关** | `$DSH_HOME/settings.yaml` | — |

`.credentials.yaml`、`.anonymous-user-id` 之类的机器本地机密**从不进入计划**，无论开关怎么设。

## 会话相关功能

- **整目录备份**：会话是一批 generation 文件（`session.jsonl.zstd` 与更新的 `session.vN.jsonl.zstd` 可能同时存在，前者是迁移前身、别丢），按字节复制，不做解码/重编码。
- **本机浏览**：按工作区分组列出会话数、体积、最近修改时间与最大的日志文件名。
- **远端浏览**：列出每台机器备份的工作区与会话数/体积。
- **恢复**：整台机器、单个工作区、或先 `dryRun` 预览。恢复前自动把当前状态拍成本地快照（`pre-restore-*`）。
- **工作区重映射**：两台机器上同一个项目路径不同时，可以在恢复时把远端的工作区目录名映射到本机已有工作区，文件就会落到 dsh 真正会扫描的目录里。
- **阅读日志**：直接点会话名，把 zstd 日志解压成文本在页面里看（Node ≥ 22.15 提供 zstd；不支持时接口明确返回 501）。
- **本地快照**：只存本机（`$DSH_HOME/dsh-github-sync/snapshots/`），滚动保留 `snapshotKeep` 份，用于快速回滚；每次都可在推送前自动拍一份。

## 安全

- **令牌只写不回读**：接口返回的永远是 `hasToken`，不是令牌本身；令牌存在 settings 命名空间（`role('secret')`）或 `$DSH_HOME/dsh-github-sync/config.json`。
- **强制私有仓库**：`POST /api/sync` 每次都会先读仓库元数据，`private !== true` 直接拒绝。
- **改状态的请求校验同源**：路由由插件自己注册在回环 web server 上，没有内核 `/api` 那层 cookie 栅栏，因此对 `PUT`/`POST` 做了 Origin/Host 比对。
- **恢复路径受限**：工作区目录名必须是 `--…--` 形状的单个路径段，会话日志读取被限制在 `$DSH_HOME/sessions` 之下。

## HTTP API

路由前缀 `/dsh-github-sync/api`（同源 `fetch`，无需额外认证头）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 实例 ID、配置、上次结果、本地统计、快照数 |
| PUT | `/settings` | 局部更新设置；`token: ''` 清除令牌 |
| POST | `/verify` | 读仓库元数据，判断私有/可推送 |
| POST | `/sync` | 立即推送（关掉的组不会删远端） |
| GET | `/remote` | 远端各实例清单（分支提交时间作为「最近备份」） |
| GET | `/sessions/local` | 本机会话清单 |
| POST | `/sessions/restore` | `{instanceId, workspace?, map?, overwrite?, dryRun?}` |
| GET | `/sessions/text` | `?local=1&workspace=&session=&file=` 或 `?path=<仓库路径>` |
| GET | `/snapshots` | 本地快照列表 |
| POST | `/snapshots` · `/snapshots/restore` · `/snapshots/delete` | 新建 / 恢复 / 删除快照 |

## 开发

```bash
npm test              # node:test，含一个把 GitHub 换成内存实现的端到端集成测试
npm run build:client  # 由 client/index.js 生成 client/bundle.js
npm run check         # 两个入口的语法检查
```

- 宿主半边是 **ESM**：`export { name, inject, apply }`，`apply(ctx, config)` 里用 `ctx.effect` 包住 `ctx.webServer.register`。
- 客户端半边由 `scripts/build-client.mjs` 包成 `window.__ModuleLoader__.load({ id, factory })`，**id 必须等于包名**，`exports["./client"]` 指向构建产物。
- 测试不需要网络：`test/fake-github.mjs` 是一个内存 GitHub，`test/plugin.test.mjs` 用假的 req/res 驱动真实路由。

## 已知限制

- **跨机恢复不会改写会话 header 里的 `cwd`**。dsh 的 `list()` 只看目录，所以会话会出现在映射后的工作区下；但日志体里的绝对路径仍是原机器的。要做到无损，恢复时得解压/改序化/重压缩每一帧——那会破坏「源文件字节不变」的格式契约，因此没做。
- `$DSH_HOME/storages/workspace.json`（工作区注册表 / 归档会话 id）不参与同步。它是机器本地的，覆盖它会影响本机侧栏；需要时可手工处理。
- 附件（`$DSH_HOME/attachments/`）不在同步范围内。
- GitHub 单个 blob 上限 100 MB，默认跳过超过 `maxFileMb`（45 MB）的单个文件并在结果里报告。
- 会话目录树很大时，GitHub 的 tree 接口可能返回 `truncated`，此时只做增量比对（插件会在结果里标注）。

## 与遗留的 `~/.dsh` git 仓库并存

如果这台机器的 `$DSH_HOME` 曾经被某个旧同步插件初始化成 git 仓库（`.git` + 自动生成的 `.gitignore`），本插件**不会碰它**：它只使用 GitHub REST API，所有自身状态都在 `$DSH_HOME/dsh-github-sync/` 下。两条链路可以并存；想彻底退役旧链路，需要手工删除 `$DSH_HOME/.git`、`$DSH_HOME/.gitignore`、`$DSH_HOME/dsh-sync.json` 与 `.dsh-sync.state.json`。

## License

MIT
