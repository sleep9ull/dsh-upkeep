# 事实与证据（DSH 0.2.2-rc.3，本机 Desktop 安装）

> 2026-11-24：本机升级到 **0.2.3-alpha.2** 后复核了 §10（新增）；其余条目仍按 0.2.2-rc.3 记录，
> 尚未逐条在 alpha 上重验。

本文只记录**已核实**的事实，供实现时对照。路径缩写：

- `R` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai`
- `D` = `<DSH_INSTALL_DIR>/docs`（`DSH_INSTALL_DIR` = `R/dsh`）
- 读取方式：`read` 工具可直接读 `app.asar` 内文件；列目录/搜索需用
  `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e '...fs...'`（原生 `ls`/`grep` 无法穿透 asar）。

## 1. 版本与运行环境

| 事实 | 证据 |
|---|---|
| 运行版 DSH = `0.2.2-rc.3`，`engines.node >=24.9.0` | `R/dsh/package.json` |
| 运行版本权威来源 = `ctx.profileContext.installAnchor`（指向运行中 `@deepseek-ai/dsh/package.json`） | `R/dsh-app-boot/src/profile-context.ts:15-37`；`R/dsh-plugin-manager/src/index.ts:514,630` |
| 等价函数 `getDshRuntimeVersion()` 从 app-boot 自身 `package.json` 读版本 | `R/dsh-app-boot/src/plugin-compatibility.ts:44-49` |
| 环境变量 `DSH_INSTALL_DIR` **只**注入到 shell 工具环境，不是 Host 进程变量 | `R/dsh-shell-env/src/index.ts:164-181,82-90` |
| CLI 可直接运行：`ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" "$DSH_INSTALL_DIR/lib/bin.js" --version` → `0.2.2-rc.3` | 实测；bin = `R/dsh/lib/bin.js`；支持 `--dump-config` / `--dump-config-schema` / `headless` |

## 2. 兼容判定（功能 1 的核心语义）

| 事实 | 证据 |
|---|---|
| 唯一判定函数 `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)` | `R/dsh-app-boot/src/plugin-compatibility.ts:87-102` |
| 规则：`engines.dsh` 存在则独自决定；否则检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer；`includePrerelease: true`；`workspace:^|~|*` 改写为运行版；空/非法范围=不满足 | 同上 `:51-74` |
| 返回 `{ name, version, runtimeVersion, requirements, exempted }` | 同上 `:8-15` |
| 豁免文件 `<profile>/compatibility.json`：`{ "name@exactVersion": ["exactDshVersion"] }`，0600，需 `acceptRisk` | `R/dsh-app-boot/src/profile-compatibility.ts:10,13,24-40,113-140` |
| 判定时机：安装/更新前（pnpm 之前）、profile 启动、每次 recomposition、plugin-market 列表 | `R/dsh-plugin-manager/src/index.ts:569-570,862-865,1086-1087,1278-1279`；`R/dsh-app-boot/src/compatibility-preflight.ts` |
| 不兼容的**插件行**：启动时被置为 `disabled:true`，只打 stderr；`listPlugins()` 表现为 `enabled:false, fiberPhase:null`，无事件、无持久化记录 | `R/dsh-app-boot/src/compatibility-preflight.ts:79-83,107-118` |
| 不兼容的**bundle**：`enabled` 仍为保存值，但 `error.code='incompatible-version'` + `incompatible[]`，无行带 `entryId` | `R/dsh-plugin-manager/src/index.ts:569-594`；`R/dsh-plugin-manager/src/types.ts:28-43,73-119` |
| Desktop Host stderr 只保留 64 KiB 内存尾巴，不落盘；`logs/startup-*.log` 仅致命错误时写 | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/lib/main.js`（`DesktopHostProcess`）；`R/dsh/src/startup-diagnostics.ts:26-68` |
| 运行时状态可观察：`readPluginInventory(ctx)` → `fiberPhase: pending|loading|active|failed|unloading|null` + `diagnostic` | `R/dsh-host-plugin-inventory/src/index.ts:82-121`；`src/types.ts:8-14,17-28` |
| 无「不兼容」事件可订阅；recomposition 只发 `app-boot/config-reload` | `R/dsh-app-boot/src/index.ts:55,427` |

## 3. 版本感知（功能 1 的输入）

| 事实 | 证据 |
|---|---|
| 无任何 DSH 服务暴露「最新 DSH 版本」；`pluginManager.inspect/listVersions` 拒绝 `@deepseek-ai/dsh` | `R/dsh-plugin-manager/src/index.ts:651-683`（`not-a-bundle` / `not-updatable`） |
| npm `@deepseek-ai/dsh` dist-tags 实测：`latest=0.2.2-rc.1`、`next=0.2.2-rc.3`、`alpha=0.2.2-alpha.3` → **`latest` 滞后，不可用于决策** | 实测 `https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags` |
| 注册表计划可由 `ctx.pluginManager.registries()` 取得；默认 npmjs + `registry.npmmirror.com` 回退 | `R/dsh-plugin-manager/src/index.ts:600-611`；`src/registry.ts:13-17,54-76` |
| Host 进程内 `fetch` 已被进程级代理接管（HTTP_PROXY/HTTPS_PROXY 生效，无 SOCKS） | `R/dsh-http-proxy/README.md`；`D/user/guide/network-proxy.md` |
| Desktop 更新通道来自 `Resources/app-update.yml`（provider generic，channel nightly），feeds `<channel>-mac.yml` 可取 `version`；`latest-mac.yml` 404 | 实测；`D/upgrade-guide/v0.2.2-alpha.2/desktop-stable-channel/guide.md` |
| `pluginManager.listVersions(name)` 返回新版本及每版 `incompatible` 记录，可用于「升级插件版本」路线 | `R/dsh-plugin-manager/src/index.ts:679-717`；`src/types.ts:282-319` |

## 4. 迁移知识（功能 2 的输入）

| 事实 | 证据 |
|---|---|
| `docs/upgrade-guide/`：13 个版本目录、143 个 item；每个 item 固定 `guide.md` + `guide.zh.md` | 实测目录；`D/upgrade-guide/README.md` |
| item 结构固定：frontmatter `kind: upgrade-guide` + `description`；正文 `## Change` + `## Migration`（中文 `## 变更`/`## 迁移`） | 抽查 `D/upgrade-guide/v0.2.2-rc.1/plugin-update-method/guide.md` 等 |
| `v<T>` 目录 = 「离开 release T 时」的破坏；从 vA 到 vB 取 `[vA, vB)` 按序 | `dsh-doc/references/upgrading.md:3,10,12-13` |
| npm 包**不含** docs（tarball 无 `docs/`）；未安装版本需按 tag 从 GitHub 取 | 实测 `dsh-0.2.2-rc.1.tgz` 文件列表；`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/docs/upgrade-guide/...` 200 |
| `docs/persistence-schema.json`：每个持久化类型/事件一个 SHA-256，可跨版本 diff | `D/persistence-catalog.md`；实测 rc.1→rc.3 有 6 个 root 变化、新增 `event:team/mode` |
| 唯一机器可读指纹之外，没有 break 索引；判断适用性需要 LLM | 同上 |

## 5. Host↔Client 与 UI

| 事实 | 证据 |
|---|---|
| Host 注册认证 Fetch 路由：`ctx.connection.fetch.register({ path:'/api/<plugin>/<action>', methods, requestBody:'buffered', fetch:(request,peer)=>Response })` | `R/dsh-client-connection/src/rpc-host.ts:115,236-250,401-415`；`R/dsh-plugin-manager/src/index.ts:396-400`（生产实例） |
| `/api` 栅栏对任意未认证路径返回 `401`（实测 `/api/upkeep/status` 与不存在的 `/api/upkeep/does-not-exist` 同为 401），因此 401 只证明栅栏生效，不证明具体路由已注册 | 实测（Desktop GUI `127.0.0.1:60105`）；栅栏实现见 `R/dsh-client-connection/src/rpc-host.ts:209-224` |
| 客户端调用：`ctx.connection.rpc.call('/api', '<plugin>/<action>', payload, signal)`，信封 `{type:'client-request',rpcId,method,payload}` → `{type:'server-response',rpcId,result}` | `/Users/jinchunxu/dev/dsh-asc-hub/src/host/rpc.ts:1-109`；`src/client.ts:892`（真实使用） |
| 已有可参考的第三方实现：`@sleep9ull/dsh-asc-hub`（Host/Client 双半、一个 dispatcher 同时服务 RPC 与 agent 工具、双 tsconfig、locale/icon/engines） | `/Users/jinchunxu/dev/dsh-asc-hub/{package.json,src/index.ts,src/host/dispatch.ts}` |
| 可用 UI slot：`settings.plugins.tab`（Plugins 设置页分页）、`settings.section`、`settings.section.icon`、`sidebar.footer.action`、`sidebar.toggle.badge`、`shell.overlay`、`settings.general.item` | 实测 `cordis_inspect_query` → Client `Slots.listSubTree` |
| `conversation.chat.node` 的 key 表是固定的（不能新增 Chat 节点类型）；`tool.call.toolview` 的 key 是开放的（可自定义工具渲染） | 同上 |
| 禁止 iframe 承载 Host 页面；样式用 `--dsw-alias-*`；不 require Harness Client 包 | `dsh-doc/references/practices.md:31-38`；`references/ui-plugin.md:7-13` |
| DSH 无 Host→浏览器推送；无会话可显示的只有客户端 slot 渲染的内容 | Schedule 子研究报告；`R/dsh-client-ui-workspace` toast key 是封闭联合 |

## 6. 会话 / agent / 执行

| 事实 | 证据 |
|---|---|
| `ctx.subagents.startActivation({ provider, parent: <live Agent>, prompt, signal, label, delivery })`；**parent 必须是活的 Agent，不能传 session id** | `R/dsh-subagent/src/types.ts:29-46,144-191`；`src/index.ts:275-277` |
| 被委派子 agent 的审批固定为 `never`（沙箱升级类操作会直接失败） | `R/dsh-subagent/src/child-agent.ts:249-279`；`D/subsystems/approval.md:42` |
| 创建 agent：`ctx.agents.create({ sessionId, meta:{ cwd }, agentOptions, ... })`；`ctx.agentLoop.createAgent(ownerCtx, options)` | `R/dsh-agent/src/index.ts:66-121,160-163,410-419`；`R/dsh-agent-loop/src/index.ts:719-747` |
| 客户端启动会话：`ctx.uiWorkspace.startSession(workspaceId?, { prompt?, agentPreset? })`；`prompt` 只预填草稿，不自动发送 | `R/dsh-client-ui-workspace/src/client/navigation.ts:34-37`；`R/dsh-client-ui-conversation/src/client/contract/input.ts:242-253` |
| Host 确定性执行：`ctx.shell.resolve(ShellExecRequest)` → `ctx.shell.execute(spec)`（workdir/timeout/stdout 上限/signal） | `R/dsh-shell/src/types.ts:111-165`；`R/dsh-bash-sandbox/src/index.ts:85-124` |
| 后台任务：`ctx.jobs.start/list/read/readAt/kill/wait` | 实测 Service 目录；`R/dsh-jobs-local/README.md` |
| 实验包 `worktrees`：`ctx.worktrees.create(agent, {name?, from?})` → `{path,branch,baseCommit,repositoryRoot}`，会切换会话 cwd；脏工作区不复制未提交改动；非 git/HEAD 报错 | `R/dsh-experimental-worktree/src/index.ts:159-174,262-285`；`README.md:35` |
| 实验包默认未挂载到 desktop profile（bundles 只有 `dsh-base`、`dsh-web-app`、`@sleep9ull/dsh-asc-hub`） | `~/.dsh/profiles/desktop/package.json` |

## 7. 交付（PR / 合并）

| 事实 | 证据 |
|---|---|
| `ctx.forge` **没有** create PR 方法；提供 `readiness / merge / findByHead / watch / latest / fetchChecks / diff / submitReview …` | 实测 Service 目录；`R/dsh-experimental-forge/src/types.ts:492-578` |
| `forge-github` 通过本机 `gh` 工作，`readiness` = `gh auth status --hostname` | `R/dsh-experimental-forge-github/README.md`；`src/provider.ts:343-349` |
| 创建 PR 的实际路径 = `gh pr create`（Host 子进程或会话内 agent）；forge 负责随后跟踪 | `R/dsh-experimental-forge-session/README.md:12,39` |
| 本机：`git 2.56.1`、`gh 2.103.3`，`gh auth status` 已登录 `github.com / sleep9ull`（keyring） | 实测 |
| `pnpm` 不在 PATH（`which pnpm` 空）；`npm`/`node` 有 | 实测。需要 `load_workspace_dependencies` 或 corepack/npm 安装 |

## 8. 定时任务

| 事实 | 证据 |
|---|---|
| `ctx.schedule.create(request, actorSessionId?, signal?)` 公开可调，无审批、无会话要求 | `R/dsh-schedule/src/index.ts:381` |
| `ScheduleCreateRequest = { title, prompt, timing, target? }`；timing kinds：`after|at|every|daily|weekly|cron|rrule`；`every_seconds >= 60`；`after_seconds > 0`；`at` 必须未来 | `R/dsh-schedule/src/types.ts:335,478`；`src/domain.ts:45,319,851,951` |
| target：现有会话 / `new_once` / `new`，新建会话可带 `create.cwd` 与 `create.agentPreset` | `R/dsh-schedule/src/types.ts:345,375` |
| 投递 = 以 `source:'schedule'` 的用户消息 `followup()` 给 agent，开启一轮 turn | `R/dsh-schedule/src/runtime.ts:353-360`；`src/domain.ts:1159` |
| 任务变更事件 `schedule/changed`；管理 UI 由 `dsh-client-ui-schedule` 提供 | 实测 Event 目录；`R/dsh-client-ui-schedule/README.md` |
| 目标会话被归档会删除其任务；投递为 at-least-once，需要 Host 在运行 | `R/dsh-schedule/README.md` |

## 9. 插件自身声明与加载

| 事实 | 证据 |
|---|---|
| `engines.dsh` 存在时独占判定；不声明则每个 `@deepseek-ai/dsh-*` peer 都是硬锁 | `R/dsh-app-boot/src/plugin-compatibility.ts:55-74` |
| Host 插件导出形式：`export function apply(ctx, config)` + 可选 `inject` / `Config`；资源用 `ctx.effect`/`ctx.on` 注册并返回清理 | `dsh-doc/references/host-plugin.md:58-65` |
| Bundle manifest：`dsh.bundle.patch` 指向 cordis.patch.yml；`dsh.client` 声明客户端半 | `dsh-doc/references/host-plugin.md:5-27`；`references/ui-plugin.md:3` |
| `listBundles().source` 只对 installation-owned bundle 返回；`file:`/`link:` 被归一化为 `file:/abs` / `link:/abs`，**不区分目录与本地 tarball**（`"file:../p-0.1.0.tgz"` 也是 `file:/abs/p-0.1.0.tgz`） | `R/dsh-plugin-manager/src/index.ts:547-548`；`R/dsh-plugin-manager/src/install-spec.ts:147-152` |
| 包根本身由 DSH 从 profile 解析（`bundleManifest(name, profile.dir, installAnchor)`），与 `source` 无关；`source` 只是安装规格的回显 | `R/dsh-plugin-manager/src/index.ts:554` |
| 插件可 peer 声明 DSH 包以共享安装版实例（linked checkout 场景） | `D/user/develop/basic/publish.md:105-107` |
| 装包后确认生效看 `application`/`warnings`，不看日志或进程 | `dsh-doc/references/plugin-development.md:20` |

## 10. Loader 启动顺序与服务可用性（0.2.3-alpha.2 复核）

| 事实 | 证据 |
|---|---|
| 同一 `EntryGroup` 内的兄弟行**并发**启动：`update()` 对每个 id 执行 `await Promise.all(...)` | `R/cordis-plugin-loader/src/config/group.ts:95-103` |
| 一行只在**自己 `inject` 里的服务**就绪后变 ACTIVE；其它服务此时可能仍未挂载 | `R/cordis/src/fiber.ts:639-650`（`_refresh` 只遍历 `this.inject`）；`R/cordis/src/registry.ts:330`（`Inject.resolve(plugin.inject)`） |
| `ctx.inject(deps, callback)` 是 `ctx.plugin({ inject, apply: callback })` 的简写：依赖就绪才运行，依赖变化时重跑 | `R/cordis/src/registry.ts:169-176,296-301`；`dsh-doc/references/practices.md:20` |
| 因此 **`apply` 时 `ctx.get(name)` 可能是 `undefined`**：本机 0.2.3-alpha.2 实测 `upkeep` 行 apply 时 `pluginManager` 与 `tools` 都未挂载（面板警告 "The plugin manager service is not mounted"、`Tool.listTools` 无 `upkeep_status`），而同一进程稍后 `listPlugins()` 返回 231 条、`listBundles()` 返回 5 个 bundle；重载该行后两者都恢复 | 实测 2026-11-24（`~/.dsh/upkeep/state.json` 的 11:00 检查）；修复见 `src/host/dispatch.ts` 的 `managerOf` 与 `src/index.ts` 的 `ctx.inject(['tools'], …)` |

## 客户端模块表与 primitives 的可达性（0.2.2-rc.3）

- 页面的模块种子表由 web 产物里的 `qJ()` 返回，键为：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
  出处：`dsh-web-frontend/dist/assets/index-Ciz7DZxv.js`（`function qJ(){…}`）。
- 模块加载器的同步 `require` 先查种子表，命中即返回：
  出处：`dsh-client-modules/src/client/system.ts`（`if (this.seed.has(spec)) return this.seed.get(spec)`）。
- **但插件不得 require 宿主客户端包**（含 `@deepseek-ai/dsh-client-ui-primitives`）：会随版本无预警变化，且组件抛错会让整个 slot 变空白（控制台 `slot entry crashed in '<slot>'`）。允许的做法是照抄 markup/CSS/行为，类名加自己的前缀，只保留 `--dsw-alias-*` token。
  出处：`dsh-agent-preset/skills/dsh-doc/references/practices.md` §UI（第 35 行）。
- 结论（D15 复核）：**技术可达 ≠ 允许使用**；本插件的客户端仍只 `require('react')`，控件样式按宿主 CSS 度量手写。

## schedule 服务的编辑与删除（0.2.2-rc.3）

- 没有独立的 delete 方法；删除与改写都走 `edit`：
  `{ id, action: 'update', patch: { title?, prompt?, timing?, target?, active? }, expectedUpdatedAt? }` 或 `{ id, action: 'delete', expectedUpdatedAt? }`；
  冲突返回 `{ code: 'schedule_conflict' }`。
  出处：`dsh-schedule/src/types.ts`（`ScheduleEditRequest`、`SchedulePatch`）与 `dsh-schedule/src/index.ts`（`action === 'delete'` 分支）。
- 任务记录里可读的事实：`EveryScheduleRecord.everySeconds` 与 `scheduledAt`（下一次锚定时刻）。
  出处：`dsh-schedule/src/types.ts`。
- 一次性投递：`timing: { kind: 'after', after_seconds }` + `target: { kind: 'new_once', create: { cwd } }`，用于让 agent 无人值守地开始执行。
