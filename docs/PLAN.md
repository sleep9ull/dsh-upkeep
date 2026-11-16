# dsh-upkeep 可行性评估与实施计划

> 评估基线：本机安装的 DeepSeek Harness **0.2.2-rc.3**（Desktop，profile `desktop`）。
> 所有"Dsh 是否支持 X"的结论都取自安装版源码/文档，证据见 [EVIDENCE.md](EVIDENCE.md)。
> 本文写作时间：2026-11-15。

---

## 0. 结论摘要

**三个功能全部可行，但可行性并不相同。**

| 功能 | 可行性 | 主要依据 | 最大难点 |
|---|---|---|---|
| 1. 监测清单 + 不适配提示 | **高** | DSH 自带唯一的兼容判定函数 `evaluatePluginCompatibility`；`pluginManager` 暴露已安装清单；`profileContext.installAnchor` 给出运行版本 | 「最新版 DSH」DSH 自己没有发布源，需要自建版本感知；被拒绝的插件行没有可订阅事件，必须自行重算 |
| 2. 一键定向升级 | **中高** | 升级指南是 143 条结构高度规整的文档；`ctx.subagents`/`ctx.agents` 可拉起编码 agent；Host 半可用 `ctx.shell`/`ctx.subprocess` 跑测试与 `gh`；本机 `gh` 已登录 | 「代码修改 + 验证 + 交付」的闭环要跨 3 个系统（DSH 会话、git/worktree、GitHub），且无人值守 agent 的审批被固定为 `never`，交付必须由人确认 |
| 3. 定时自动化 | **高** | `ctx.schedule.create()` 可被 Host 插件直接调用（无需审批、无需会话），支持 7 种时间表达式与「新建会话」目标 | DSH 没有 Host→浏览器推送；"后台发现不兼容"只能靠客户端半边的轮询/状态展示或定时任务本身 |

**推荐路径**：先做 M0 脚手架 + M1 只读监测（约 10–15 人天即可产生真实价值），再投入 M2–M4 的升级闭环。升级闭环里唯一不可自动化的环节是"人工确认交付"——这既是 DSH 的安全边界，也是产品应有的默认值。

**一个重要的现成资产**：本机 profile 里已安装的第三方插件 `@sleep9ull/dsh-asc-hub`（仓库 `/Users/jinchunxu/dev/dsh-asc-hub`）已经解决过同一组工程问题——Host/Client 双半、`/api` RPC 通道、一个 dispatcher 同时服务 UI 与 agent 工具、双 tsconfig 构建、locale/icon/plugins 元数据。dsh-upkeep 应直接沿用这套工程规范，不重新发明。

---

## 1. 事实基线（已核实）

### 1.1 DSH 如何判定"插件不适配"

DSH 只有一个官方判定入口，位于 `@deepseek-ai/dsh-app-boot`：

```ts
evaluatePluginCompatibility(
  manifest,                    // 插件 package.json
  exemptions = {},             // <profile>/compatibility.json
  runtimeVersion = getDshRuntimeVersion(),
): PluginCompatibility | undefined
```

规则（`src/plugin-compatibility.ts:55-102`）：

- 如果插件声明了 `engines.dsh`，它**单独决定**，`peerDependencies` 被忽略；
- 否则检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 依赖；
- 范围用 `semver.satisfies(runtime, range, { includePrerelease: true })`；
- `workspace:^|~|*` 改写为运行版本；空/非法范围判定为不满足；
- 什么都没声明则不检查；
- 豁免只能是 `<精确 name>@<精确 version>` → 精确 DSH 版本，写在 `<profile>/compatibility.json`。

**关键限制（直接影响功能 1 的设计）**：

1. 被判定不兼容的**插件行**不会加载，行为是"启动时把该行置为 `disabled: true`"，只向 stderr 打一行日志。`listPlugins()` 返回 `enabled:false, fiberPhase:null`，**与用户手动禁用无法区分**，也没有任何事件或持久化记录。
2. 被判定不兼容的**整个 bundle** 表现为 `BundleInfo.enabled === true`（保留用户选择）但带 `error.code === 'incompatible-version'` 和 `incompatible[]`，且没有行带 `entryId`。
3. Desktop 的 Host 子进程 stderr 只保留 64 KiB 内存尾巴用于退出报错，不落盘；`logs/startup-*.log` 只在致命 `StartupError` 时写。
4. 运行时激活失败（import 抛错、`apply()` 抛错、缺服务）**可以**观察：`readPluginInventory(ctx)` 的 `fiberPhase`（`pending|loading|active|failed|unloading|null`）+ `diagnostic`。但它是时点快照，没有历史、没有订阅。

**结论**：功能 1 必须是"**自己重算 + 自己存历史**"，不能等 DSH 推送；同时要覆盖三层状态（声明层 / 运行层 / 前瞻层）。

### 1.2 "最新版 DSH" 没有官方来源

- DSH 只比较**运行版本**，没有任何 SDK 告诉你最新版本。
- `pluginManager.inspect()` / `listVersions()` 明确拒绝 `@deepseek-ai/dsh`（不是 bundle / 不可更新）。
- npm 上 `@deepseek-ai/dsh` 的 `dist-tags`：`latest` = 0.2.2-rc.1，`next` = 0.2.2-rc.3（即当前安装版），`alpha` = 0.2.2-alpha.3。**`latest` 是滞后的**，直接信它会得出"你比最新版还新"的错误结论。
- Desktop 走 electron-updater 的 generic feed：`Resources/app-update.yml`，本机通道 `nightly`，`<channel>-mac.yml` 可取到 `version: 0.2.2-rc.3`；`latest-mac.yml` 404（v0.2.2-alpha.2 起通道改名）。

**结论**：目标版本必须建模为"**通道 + 手动指定**"，并在 UI 里明确显示"比较对象"。默认策略建议：`max(已发布 semver)` 作为"是否存在更新"信号，通道标签只用于展示，绝不单独使用 `dist-tags.latest`。

### 1.3 迁移知识是结构化的，可以机械消费

`<DSH_INSTALL_DIR>/docs/upgrade-guide/`：

- 13 个版本目录（`v0.1.7-rc.2` … `v0.2.2-rc.1`），共 **143 条** item，每条一个目录，固定包含 `guide.md` + `guide.zh.md`；
- 每条 frontmatter 固定为 `kind: upgrade-guide` + `description`，正文固定为 `## Change` + `## Migration`（中文版 `## 变更` + `## 迁移`）；
- `README.md` 是生成的一览索引（每个版本一节，每节一张表，相对链接）；
- 语义：`v<T>` 目录表示"**离开** release T 时发生的破坏"，从精确起点 vA 迁移到 vB 需按顺序读 `[vA, vB)` 的目录；
- 另外 `docs/persistence-schema.json` 是唯一的机器可读指纹文件（每个持久化类型/事件一个 SHA-256），可跨版本 diff 出"持久化结构变了哪些"。

对**比当前安装版更新的版本**，npm 包不含 docs（已核实 tarball 无 `docs/`），需要按 tag 从 GitHub 取：`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v<version>/docs/upgrade-guide/...`（已验证可访问）。

### 1.4 可用的扩展面（与三个功能相关的）

| 能力 | DSH seam | 状态/限制 |
|---|---|---|
| Host 插件注册工具 | `ctx.tools.register()` | 稳定，已有先例 |
| Host↔Web 客户端 RPC | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` + 客户端 `ctx.connection.rpc.call('/api', method, payload, signal)` | 通道自带浏览器信任栅栏（401/403），无需 Typert 代码生成；asc-hub 已生产使用 |
| 管理页 UI | Client slot `settings.plugins.tab`（Plugins 设置页内的分页）、`settings.section`（独立设置页）、`sidebar.footer.action`、`shell.overlay`、`settings.general.item` | 纯 React 组件注册；**不要**用 iframe 承载 Host HTML |
| 常驻提示 | `shell.overlay`（自绘）+ `sidebar.footer.action` 角标 | DSH 没有 Host→浏览器 push，必须客户端半轮询 RPC |
| 拉起编码 agent | `ctx.subagents.startActivation({ provider:'spawn', parent:<live Agent>, prompt, ... })`；`ctx.agents.create({sessionId, meta:{cwd}})`；`ctx.agentLoop.createAgent()` | subagent 的 **parent 必须是活的 Agent**（不是 session id）；被委派子 agent 的审批策略固定为 `never`，不能升级沙箱、不能弹审批 |
| 启动会话（客户端） | `ctx.uiWorkspace.startSession(workspaceId, { prompt, agentPreset })` | `prompt` 只**预填草稿**，不自动发送；用户按回车才执行 |
| 确定性执行命令 | `ctx.shell.resolve()/execute()`（Host）或 `ctx.subprocess` | Host 半在 workspace 沙箱之外进程内运行；命令本身可指定 workdir/timeout；`ctx.shell` 不经过工具审批 |
| Git worktree | `ctx.worktrees.create(agent, {name?, from?})` | 实验包，**桌面 profile 默认未挂载**；会**切换当前会话 cwd**；脏工作区不复制未提交改动。降级方案：Host 直接 `git worktree add` |
| PR / 合并 | `ctx.forge`：`readiness / merge / findByHead / watch / latest / fetchChecks / diff` | **没有 create PR**；forge 系列是实验包，默认未挂载；`forge-github` 依赖本机 `gh`（已登录 sleep9ull）。创建 PR 只能走 `gh pr create`（Host 子进程或会话内 agent） |
| 定时任务 | `ctx.schedule.create(request, actorSessionId?, signal?)` | Host 插件可直接调用，无审批、无会话要求；`every_seconds >= 60`；target 支持 `session / new_once / new`，`new*` 可带 `create.cwd` 与 `agentPreset`；投递方式是把 prompt 作为 `source: 'schedule'` 的用户消息 `followup()` 给 agent |
| 持久化 | `ctx.storage.domain`（schema 校验 KV，带 `domain/changed` 事件）/ 插件 Config | 配置放 Config（用户在 cordis.patch.yml 可改），动态清单与历史放 storage domain |
| 运行版本 | `ctx.profileContext.installAnchor`（运行中 `@deepseek-ai/dsh/package.json` 绝对路径）→ `.version`；或 `getDshRuntimeVersion()` | **不要**读 `process.env.DSH_INSTALL_DIR`（它只存在于 shell 工具环境，不在 Host 进程） |
| 兼容评估器复用 | `import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'` | 可用但**无稳定性承诺**；记录形状已变过一次（`peers`→`requirements`，v0.2.1-alpha.3）。建议 vendor 一份 40 行实现 + 启动时能力探测 |
| 自身声明 | `package.json` 的 `engines.dsh` | 一旦声明 `engines.dsh` 就**独自决定**，peer 被忽略；不声明则每个 `@deepseek-ai/dsh-*` peer 都变成硬锁 |

### 1.5 DSH CLI 可用（验证策略的关键）

Desktop 安装包里的 CLI 可以从任意 shell 直接跑：

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" "$DSH_INSTALL_DIR/lib/bin.js" --version
# → 0.2.2-rc.3
```

支持 `--dump-config`（只组合 profile，不 import 插件代码）、`--dump-config-schema`、`headless`（单任务跑完退出）等。这意味着 dsh-upkeep 可以建立一个**真实的兼容性实验台**：

1. `dsh --profile <tmp> --dump-config`：静态准入检查（是否存在被拒行/被跳过 bundle）；
2. 临时 profile 里装上被测插件 + 目标 DSH 版本，`dsh headless` 跑一个最小任务：真实启动验证；
3. 全程不碰用户当前 profile。

---

## 2. 逐特性可行性评估

### 2.1 功能 1：监测清单 + 不适配提示 — 可行性高

**能做什么**

- **监测范围**：只监测第三方插件；`@deepseek-ai/*` 属于 DSH 自身、随 DSH 版本发布，排除在清单之外，并用 `excluded` 计数透明报告排除了多少 bundle / 条目（见 D13）。
- **归属与维护结论**：对每个第三方 bundle 判定 `mine / other / unknown`（证据来自 scope、author、repository、本地 checkout 的 git remote，匹配本地身份），只有 `mine` 的插件才进入"是否需要维护"判定；每条结论带证据，未知不猜测（见 D14）。
- 自动发现：`ctx.pluginManager.listBundles()` 给出已安装 bundle 的 `name/version/source/availability/update/rows[]/error`；逐行解析 `package.json` 得到 `engines.dsh` 与 DSH peer 依赖。
- 三层判定：
  - **声明层**：插件 manifest 对 `running` 版本、对**目标版本**分别求值（后者用 `evaluatePluginCompatibility(manifest, {}, targetVersion)` 即可预测"新 DSH 发布后会不会坏"）。
  - **运行层**：`readPluginInventory(ctx)` 的 `fiberPhase`/`diagnostic`，识别 import/apply 失败与缺服务挂起。
  - **历史层**：每次检查落库，形成"某插件从哪个 DSH 版本开始不兼容"的时间线（DSH 自己完全不提供）。
- 前瞻价值：在**新 DSH 发布之前**就能算出"这个插件会坏"，这是比现状（等装上新版才发现被禁用）更强的产品点。
- 提示：设置页列表 + 侧边栏角标 + 可选创建一次性提醒任务。

**缺口与应对**

| 缺口 | 应对 |
|---|---|
| 被拒绝的插件行无事件、无状态 | 重算声明层；保存自己的检查历史；UI 上区分"声明不兼容 / 运行失败 / 用户禁用" |
| "最新版"无官方源 | 自建版本感知：npm packument（`fetch` 已被进程级代理接管），按通道 + 手动指定；缓存 + 离线降级，UI 标注"数据时间" |
| 已安装的 registry 包没有源码仓库 | 降级为"只报告"：用 `pluginManager.listVersions(name)` 找**已发布的、兼容目标版本的**新版本，提示"升级插件版本"而不是改代码 |
| 运行层诊断没有历史 | 每次检查时快照 `fiberPhase` + `diagnostic`，落库 |

**为什么要区分"三层"**：`engines.dsh` 写对了不代表能跑（slot 改名、事件签名变了不会体现在 engines 里）；反过来 `fiberPhase: failed` 也可能只是缺依赖。分开呈现，作者才知道该改 manifest 还是改代码。

### 2.2 功能 2：一键定向升级 — 可行性中高

拆成 5 个子环节单独评估：

| 子环节 | 可行性 | 做法 | 风险 |
|---|---|---|---|
| 2a 定位受影响面 | **高** | 机械扫描插件：`package.json`（engines/peers/exports/`dsh.bundle.patch`/`dsh.client.inject`）、patch yml（row id、module name、`inject`、config 键、`!!js` 里的 `ctx.*`）、源码（`@deepseek-ai/*` import、`ctx.<service>`、事件字符串、工具/命令名、slot id）；与 143 条指南条目做多面匹配并排序 | 动态用法（拼出来的事件名、运行期注册）会漏 |
| 2b 生成迁移计划 | **中高** | 机械候选 + 指南原文 `## Change`/`## Migration` + 命中代码片段 → LLM 产出结构化计划（要改哪些文件、怎么改、验收命令、风险）；歧义时用 `ctx.userQuestions` 提问 | 语义适用性判断只能靠 LLM；需用测试兜底 |
| 2c 执行修改 | **高** | 在**独立会话**（cwd=被测仓库，或 worktree）里让 agent 按计划改；用户可实时看、可打断、可用审批 | 需要把被测仓库注册成 workspace；会话内 agent 的沙箱是 workspace-write |
| 2d 自动验证 | **中高** | 分层 oracle：①manifest 兼容重算 ②仓库自带 check/test ③`dsh --dump-config` 临时 profile ④`dsh headless` 真实启动 ⑤可选：装目标 DSH 版本做跨版本验证 | pnpm 不在 PATH、临时 profile 安装链路需要 M0 打通；④⑤ 有成本与噪声 |
| 2e 交付 | **中** | Host 半执行 `git commit`/`git push`/`gh pr create`/`gh pr merge`，每步显式确认；`ctx.forge` 可用时作为可选适配器跟踪状态 | forge 无 create PR；沙箱外执行写操作需强确认与 path allowlist；合并 main 属于高危默认关闭 |

**关键架构判断（避免踩坑）**

- **不要让"无人值守子 agent"负责交付。** 被委派子 agent 的审批固定 `never`，`git push`/`gh` 这类越界或凭据访问会直接失败；交付应由 **Host 半**（有用户确认门）或**用户可见的会话内 agent** 执行。
- **升级必须在"会话"里发生，而不是插件直接改文件。** 这样才有审批、todo、可中断、可追踪；插件负责编排与验证，agent 负责编辑。
- **默认 PR，不自动合并。** 合并 main 需要用户显式打开开关 + 每次确认。

**降级路径（很重要）**

- 仓库不可写 / 不是 git / 没有测试命令 → 退化为"生成迁移报告 + 补丁建议"，不执行修改；
- 只有 registry 安装包、没有仓库 → 退化为"提示可用版本 + 一键 `updateBundle`"；
- 没有 `gh` / 未登录 → 退化为"本地分支 + diff + 手动推送指引"。

### 2.3 功能 3：定时自动化 — 可行性高

**能做什么**

- Host 插件直接调 `ctx.schedule.create({ title, prompt, timing, target })`：
  - `timing`: `after | at | every | daily | weekly | cron | rrule`，`every_seconds >= 60`；
  - `target`: 现有会话 / `new_once` / `new`，新建会话可带 `cwd` 与 `agentPreset`；
  - 投递：作为 `source: 'schedule'` 的用户消息 `followup()` 给 agent，会开启一轮 turn —— 因此 prompt 里可以直接要求"调用 upkeep 工具做检查，若发现 X 就启动升级流程"。
- 生成"人类可读的任务预设"：每天/每周/DSH 有新版时（这个需要检测触发，见下）；目标仓库/工作区、是否自动修复、是否只报告。
- 管理：复用 DSH 自带的定时任务页面（`@deepseek-ai/dsh-client-ui-schedule` 已提供任务管理 UI），我们只做"创建/深链/回执"。

**限制与应对**

| 限制 | 应对 |
|---|---|
| 没有 Host→浏览器推送 | 客户端半必须存在：设置页 + `shell.overlay`/footer 角标，通过 RPC 拉取"上次检查结果" |
| 「DSH 出新版就触发」不是 schedule 原生能力 | 用 `every`（如每 6–24h）+ 内部判断"目标版本是否变化/是否有插件变成不兼容"，只在需要时提醒；也可用 `at` 在已知发布时间点检查 |
| 投递时 Host 必须运行 | 明确告知用户这是"本机定时任务"，不是云端 |
| 目标会话被归档会删除其任务 | UI 提示；推荐 `new_once` + 专用 workspace |
| 定时任务的权限/成本 | 默认只读检查；自动修复必须要求用户创建时显式勾选，并保留人工确认交付 |

---

## 3. 关键设计决策

| # | 决策 | 推荐 | 理由 |
|---|---|---|---|
| D1 | **"适配"的判定层次** | 声明层 + 运行层 + 历史层三层分开呈现，不合并成一个布尔值 | DSH 只有声明层官方判定；运行层诊断能抓"声明兼容但跑不起来"；历史层是产品增量价值 |
| D2 | **目标版本模型** | 「通道（跟随 Desktop 当前通道 / stable / next）+ 手动指定」；比较对象在 UI 明示；`latest` 标签只展示不决策 | `dist-tags.latest` 实测滞后；通道是产品概念，semver 最大版本才是事实 |
| D3 | **升级执行模型** | 升级在**独立会话**中执行（cwd = 被测仓库或 worktree），Host 负责准备、验证、交付 | 可审批、可中断、可追踪；避免 Host 直接改文件绕过 DSH 的权限模型 |
| D4 | **无人值守边界** | agent 可以改代码、跑测试；**交付必须人工确认**；默认 PR，不自动 merge | 子 agent 审批固定 `never`；越界写操作与凭据访问本就该由人确认 |
| D5 | **前后端通道** | 沿用 asc-hub 模式：Host `ctx.connection.fetch.register` 一组 `/api/upkeep/<action>` + Client `ctx.connection.rpc.call` | 已在本机生产验证；自带 owner 栅栏；不做 Typert 代码生成，避免与 DSH 版本强耦合 |
| D6 | **UI 落点** | 主入口 = **一级侧栏面板**（`main` + `sidebar.panellist`，与 Plugins / Automation tasks 同级）；设置页分页作为二级入口；常驻提示 = `shell.overlay`/footer 角标；不做 iframe | 一级面板才够"明显"；slots 是唯一稳定 UI 扩展面，`MainPanelId` 是开放 brand，第三方插件可注册 |
| D7 | **状态存储** | 策略/通道/命令模板放插件 `Config`；检查历史与版本 feed 缓存放 `$DSH_HOME/upkeep/state.json`（版本化、原子写、有界） | DSH 的 domain storage 要求 zod record schema，与「Host 半零运行时依赖」（invariant 7）冲突；状态是可再生派生数据，文件方案更简单且可测 |
| D8 | **升级知识来源** | 本地 `docs/upgrade-guide` 为主；目标版本比安装版新时按 GitHub tag 拉取；持久化变化用 `persistence-schema.json` diff | 唯一权威、结构规整、可离线；GitHub tag 已验证可用 |
| D9 | **对 DSH 内部 API 的依赖** | 核心判定逻辑 **vendor** 一份（约 40 行）+ 运行时能力探测；只把 `ctx.*` 服务当稳定 API | app-boot 无稳定性承诺且形状变过；vendor 保证插件自身不会因内部 API 变化而崩 |
| D10 | **实验包依赖** | worktree / forge 做成**可选能力**：检测到就用，缺失走 Host `git`/`gh` 降级 | 实验包桌面默认未挂载；硬依赖会让插件在默认 profile 里不工作 |
| D11 | **自身兼容声明** | 写宽 `engines.dsh`（如 `>=0.2.2-rc.1 <0.3.0`），peer 只声明真正共享的包；发布前跑跨版本矩阵 | `engines.dsh` 一旦存在就独占判定，能防止 peer 把自己锁死 |
| D12 | **验证 oracle** | L1 静态 → L2 `--dump-config` → L3 `headless` 启动 → L4 跨版本实验台；逐级启用、逐级超时/降级 | 越往后越真实但越贵/越慢；默认跑 L1+L2，用户可选 L3/L4 |
| D13 | **监测范围** | 排除 `@deepseek-ai/*`（DSH 自带包），并用 `excluded` 计数透明报告排除了多少 bundle / 条目 | 官方包随 DSH 版本发布，列入监测只会产生噪声；"排除了什么"必须可见，否则用户会以为漏了 |
| D14 | **归属判定** | 只用证据判定 `mine/other/unknown`：包 scope、author、repository、本地 checkout 的 git remote，与本地身份（`ownerHandles`/`ownerEmails` 配置、`~/.gitconfig`、gh 登录）匹配；无信号就是 `unknown`；每条判定带证据 token | 产品问题是"**我的**插件要不要维护"；猜错会制造噪音或漏报，所以宁可显示未知并提供证据 |
| D15 | **客户端 UI 组件来源** | 不引入外部组件库；按宿主 Base UI 的 token、排版与控件规范手写等价组件（按钮、折叠、chip、台账） | DSH 客户端模块表基线只有 React，`dsh.client.external` 只解析其它 DSH 客户端包；Base UI 依赖 react-dom，打包会与宿主 React 冲突。宿主规范还要求插件不重绘应用、只用 `--dsw-alias-*` |

---

## 4. 架构设计

### 4.1 总体结构（沿用 asc-hub 的"双半 + 一个 dispatcher"）

```
dsh-upkeep/
├── package.json          # dsh.bundle.patch + dsh.client + engines.dsh + locale/icon
├── cordis.patch.yml      # 插入 row: upkeep-host (inject: connection)
├── locale/{en,zh}.json
├── icon.svg / docs/DETAIL.md
├── src/
│   ├── index.ts          # Host 插件入口 (apply)，inject: ['connection']
│   ├── client.ts         # Client 插件入口：注册 settings.plugins.tab + overlay + i18n
│   ├── host/
│   │   ├── dispatch.ts   # Hub：唯一操作实现（检查/计划/升级/交付/任务/设置）
│   │   ├── rpc.ts        # /api/upkeep/<action> Fetch 路由（Client 适配器）
│   │   ├── tool.ts       # upkeep_* agent 工具（Model 适配器，同一 Hub）
│   │   ├── compat/       # 兼容评估（vendored evaluator + 三层状态）
│   │   ├── manifest/     # 插件 manifest/patch/源码 surface 扫描
│   │   ├── guides/       # upgrade-guide 索引/区间选择/条目解析/GitHub 拉取
│   │   ├── versions/     # 运行版本/目标版本 feed/通道/缓存
│   │   ├── upgrade/      # 计划生成、worktree、会话启动、验证 oracle、回执
│   │   ├── deliver/      # git/gh/forge 适配与确认门
│   │   ├── schedule/     # 定时任务模板与创建
│   │   ├── state.ts      # storage domain 模型与迁移
│   │   └── redact.ts     # 输出脱敏
├── test/                 # 单测 + 契约测试
└── docs/                 # PLAN/EVIDENCE/ARCHITECTURE/CONTRACT（实现期补）
```

### 4.2 Host / Client 职责划分

| 职责 | Host 半 | Client 半 |
|---|---|---|
| 读运行版本、已安装清单、profile 补丁 | ✅ | ❌ |
| 网络（npm packument / GitHub docs） | ✅（进程级代理已生效） | ❌ |
| 兼容三层判定、历史落库 | ✅ | ❌ |
| 计划生成（LLM 编排） | ✅ | ❌ |
| 拉起会话 / worktree / 执行命令 | ✅ | ❌（只发请求 + 展示） |
| 展示列表、状态、diff、测试输出 | 提供 RPC | ✅ React |
| 常驻提示 / 角标 | 提供状态 | ✅ overlay/footer |
| 用户确认（危险操作） | `ctx.approval` 或显式二次确认 | ✅ 对话框 |

### 4.3 数据模型（storage domain）

```ts
type MonitorEntry = {
  id: string
  name: string                       // npm 包名
  kind: 'profile-bundle' | 'path'    // 已安装 bundle / 本机仓库
  repoPath?: string                  // kind=path 时必填
  branch?: string
  testCommand?: string               // 默认 'npm test'
  checkCommand?: string              // 默认 'npm run check'（可空）
  tracksTargetChannel?: boolean
  createdAt: number
}

type CompatReport = {
  entryId: string
  checkedAt: number
  runtimeVersion: string
  targetVersion?: string
  declared: { compatible: boolean; requirements: Record<string,string>; exempted: boolean }
  runtime?: { fiberPhase: string; diagnostic?: string }
  predicted?: { compatible: boolean; requirements: Record<string,string> }
  guides: GuideMatch[]               // 命中的迁移条目
  degraded?: 'no-repo' | 'offline' | 'no-target'
}

type GuideMatch = {
  versionDir: string                 // v0.2.2-rc.1
  item: string
  description: string
  matchedSurfaces: Array<{ kind: 'import'|'service'|'event'|'tool'|'slot'|'config'|'persisted'; value: string }>
  score: number
}

type UpgradeRun = {
  id: string
  entryId: string
  baseRevision: string
  targetVersion: string
  worktreePath?: string
  sessionId?: string
  phase: 'preparing'|'editing'|'verifying'|'awaiting-delivery'|'delivering'|'done'|'failed'|'cancelled'
  planSummary: string
  verification: Array<{ name: string; status: 'pass'|'fail'|'skipped'; detail?: string }>
  diffStat?: string
  delivery?: { kind: 'pr'; url: string } | { kind: 'merge'; sha: string } | { kind: 'none' }
  error?: { code: string; message: string }
}
```

### 4.4 升级运行状态机

```
idle
 └─(点击"升级")→ preparing   : 校验仓库/分支、算兼容报告、生成迁移计划、可选创建 worktree
     └→ editing             : 注册 workspace（worktree 或原仓库）→ 启动会话并投递任务 prompt
         └→ verifying       : L1 manifest → L2 仓库 check/test → L3/L4（可选）
             ├─ 失败 → editing（把失败输出回灌，最多 N 轮）或 failed
             └→ awaiting-delivery : 展示 diff + 测试结论 + 风险
                 ├─ 用户选 PR   → delivering → done(pr)
                 ├─ 用户选合并 → delivering → done(merge)
                 └─ 用户放弃     → cancelled（worktree 可保留/清理）
```

所有写操作在 `delivering` 前需要显式确认；同一 entry 同时只允许一个 `UpgradeRun`（storage 锁）。

### 4.5 安全模型

- **RPC 栅栏**：`ctx.connection.fetch` 自带 401/403；handler 内仍校验 `peer` 的 principal 为 owner。
- **写操作白名单**：只允许对监测清单里声明过的 `repoPath` 执行写；所有路径 realpath 归一化后校验前缀。
- **命令白名单**：只执行 Config 里的 `checkCommand`/`testCommand`/受控 `git`/`gh` 子命令；不拼接用户输入；超时 + 输出上限 + 脱敏。
- **确认门**：`git push`、`gh pr create`、`gh pr merge`、安装/更新依赖、删除 worktree 前都需要用户显式确认（客户端对话框 + Host 端二次校验，不依赖"用户点过按钮"这种隐式同意）。
- **不碰 profile 的 node_modules 作为升级目标**：被测仓库是独立 git 仓库；已安装副本只读。
- **日志**：每次操作记录 action、目标、结果、耗时、错误码（不含 token/凭据），便于排障与审计。

---

## 5. UI 信息架构

**主入口：一级侧栏面板（`main` key = `sidebar.panellist` id = `dsh-upkeep`）**

与 Plugins、Automation tasks 同级：侧栏面板列表里固定一个 Upkeep 图标（原创盾牌+循环箭头），点击进入中央栏整页。整页内容：

- 页头：标题 + 一句说明；右侧操作是「刷新」（设置页分页多一个「打开面板」）。
- **状态句（主视觉）**：一句话回答"我的插件要不要维护"——全健康 / 有 N 个需维护 / 尚未识别到你的插件；有需维护项时整句用状态错误色。
- **元信息行**：DSH 版本 / profile / bundle 数 / 插件条目数 / Upkeep 版本 / 上次检查时间，竖发丝线分隔；不做 KPI 卡片。
- **台账列表**：**按归属分成两个视觉分组**——「我的插件」在上，「其他插件」在下（他人或归属未知，**默认折叠**，点击标题展开并记住选择）。发丝线行、等宽版本号、需维护行左侧 2px 强调线；列按组裁剪：「我的插件」= Bundle / 版本 / 状态 / 维护，「其他插件」= Bundle / 版本 / 状态（分组标题右侧给出"他人 N · 归属未知 M"的拆分）。行数与安装来源放在 Bundle 单元格的悬停提示里。每组独立空态。
- **页脚**：官方包排除规则与排除计数，说明列表排除了什么。
- 详情抽屉：
  - 判定详情（`engines.dsh` 范围 vs 运行/目标版本，peer 明细，豁免状态）；
  - 命中的迁移条目（版本 → 条目 → Change 摘要 → 命中的面）；
  - 运行层诊断（fiberPhase / diagnostic 原文）；
  - 升级入口：`在 worktree 中执行` 开关、验收命令、`开始升级`。
- 升级运行面板：阶段时间线、会话链接、实时输出摘要、diff stat、测试结果、`创建 PR` / `合并到 main` / `放弃`。
- 任务区：当前定时任务、创建预设（每天/每周/仅当有新版本时）、目标工作区。

**二级入口：Plugins 设置页分页（`settings.plugins.tab`，id `dsh-upkeep`）**

插件作者本来就在 Plugins 页面，保留同一份视图；页头带「打开面板」按钮，通过 `ctx.layout.selectPanel(PANEL_ID)` 跳到一级面板。两个入口共享同一个 store 与 dispatcher，不产生第二份数据逻辑。

**常驻提示（M1 末）**

- `shell.overlay`：有 `needs-attention` 插件时显示一条轻量提示（可关闭，按检查批次去重）；侧栏图标旁可加角标。
- `sidebar.footer.action`：可选的二级快捷入口 + 角标数字。

**列表管理参考**：样式与交互对齐 DSH 自带 Plugins 页（`@deepseek-ai/dsh-client-ui-plugin-manager`），主题 token 用 `--dsw-alias-*`，文案走 `ctx.locale`。

---

## 6. 实施里程碑

> 估时为"单人、熟悉 DSH 插件开发"的净开发时间，不含等待评审/安装审批。M0 必须先做，因为通道、CLI 实验台、pnpm 三个前提任何一项不成立都会改变后续设计。

**进度：M0 完成（含 M0.1–M0.7 的 UI/监测范围迭代），M1 已实现（见 §11）。**

### M0 脚手架与可行性冒烟（2–3 天）

- 复制 asc-hub 工程规范：`tsc` 双配置、`dist/`、`cordis.patch.yml`、`locale`、`icon.svg`、`engines.dsh`、`dsh.client`。
- Host 半：`inject: ['connection']`，注册 1 个 `/api/upkeep/status` + 1 个 `upkeep_status` 工具，返回 `{ runtimeVersion, bundleCount }`。
- Client 半：注册一级侧栏面板（`main` + `sidebar.panellist`）作为主入口，同时在 `settings.plugins.tab` 保留一个二级分页；两者显示同一份数据。
- 打通 CLI 实验台：`dsh --profile <tmp> --dump-config`、`dsh headless`；确认 pnpm 获取方式（`load_workspace_dependencies` / corepack / npm i -g）。
- **验收**：安装到本地 profile 后，侧栏出现 Upkeep 图标、点击进入面板显示正确版本；设置页分页可见；RPC 未授权时 401/403；卸载后无残留；`node --test` 冒烟通过。

### M1 监测清单 + 检查引擎 + 只读 UI（6–9 天）

- storage domain（`MonitorEntry`、`CompatReport`）+ 自动发现（`listBundles` → 逐行 manifest）。
- 兼容三层判定（vendored evaluator + `readPluginInventory` + 对目标版本预测）。
- 版本 feed（npm packument，通道模型，缓存，离线降级）+ 运行版本读取。
- Check 操作 + 历史 + `domain/changed` 驱动的 UI 刷新。
- 列表/详情/状态徽标/手动检查/忽略。
- **验收**：对 asc-hub、dsh-context、dsh-worktrace 三者的判定与手工核算一致；断网时显示缓存并标注；无需打开会话即可检查；重启 DSH 后历史仍在。

### M2 迁移知识 + 定向报告（5–7 天）

- `docs/upgrade-guide` 解析（索引 + 版本区间 + 条目 Change/Migration，中英双语）。
- surface 扫描器（manifest / patch / 源码）与机械匹配、排序、置信度。
- `persistence-schema.json` 跨版本 diff。
- 详情页"受影响条目"视图；导出 Markdown 报告。
- **验收**：对一个已知破坏（例如自行把某插件 `engines.dsh` 上界改小）能定位到具体条目与代码位置；输出可解释（每条命中给出理由）；误报可人工标注。

### M3 升级执行闭环（7–10 天）

- 计划生成（机械候选 + 指南原文 + 代码片段 → 结构化编辑计划；歧义提问）。
- worktree（Host `git worktree add`，可选 `ctx.worktrees` 适配）+ workspace 注册 + 会话启动（`uiWorkspace.startSession` 预填/可配置自动发送）。
- 进度观察（session 事件 → RPC 快照/轮询）+ 状态机 + 取消。
- 验证 oracle：L1 manifest 重算、L2 `checkCommand`/`testCommand`（Host 子进程，超时/输出上限）、L3 `dsh --dump-config` 临时 profile、L4 `headless` 启动（可选）。
- 失败回灌（最多 N 轮）与 diff 汇总。
- **验收**：在测试仓库上制造真实不兼容（改引擎范围 / 改被重命名的 API / 改 slot id 各一例），一键跑通到"测试通过 + diff 合理"；失败时能给出可读原因；worktree 与原仓库互不污染。

### M4 交付（4–5 天）

- 交付确认门（逐项确认 + 风险文案 + 不可逆提示）。
- `git commit`（规范 message）→ `git push` → `gh pr create`（正文含迁移依据与验证结论）；或直接合并（默认关闭）。
- 状态跟踪（`gh pr view`；`ctx.forge` 可用时用 `watch` 跟踪）。
- worktree 清理/保留；失败回滚（保留分支，不 force）。
- **验收**：在私有测试仓库真实创建 PR；合并路径可用；权限/网络失败有清晰错误与重试；用户放弃后仓库状态干净。

### M5 自动化（3–4 天）

- 任务预设（每日/每周/仅当目标版本变化）+ `ctx.schedule.create`（`new_once` + `cwd` + `agentPreset`）。
- 生成 prompt（要求 agent 调用 `upkeep_*` 工具完成检查，按配置自动升级或仅报告）。
- 任务列表/深链/删除；复用 DSH 自带任务页。
- 定时运行回执（写入 CompatReport，客户端角标更新）。
- **验收**：创建一个每 24h 任务，手动触发或等待投递后 agent 能跑通检查；删除/暂停正常；目标版本变化时只提醒一次。

### M6 加固与发布（5–7 天）

- 自身兼容：能力探测、vendor 逻辑、`engines.dsh` 矩阵测试（rc.1/rc.3）。
- 安全复核：owner 栅栏、路径/命令白名单、脱敏、确认门、日志。
- 并发与资源：单例锁、超时、输出上限、磁盘清理。
- i18n（en/zh）、icon、`docs/DETAIL.md`（插件详情页）、README/CHANGELOG。
- 测试矩阵：单测 + RPC 契约 + 冒烟 + 真实安装 + 跨版本实验台 + 失败注入。
- **验收**：在一台"干净"DSH 上按 README 安装成功；插件详情页渲染正常；升级 DSH 到下一个 rc 后插件自身仍能加载（或被明确提示）。

**总量级**：约 32–45 人天到 M6；**只做 M0+M1（监测产品）约 8–12 人天**。

---

## 7. 测试与验证策略

| 层 | 内容 | 何时跑 | 成本 |
|---|---|---|---|
| L1 静态 | `tsc` 类型检查；manifest 兼容重算；patch/locale/icon 完整性 | 每次检查 / 每次升级 | 极低 |
| L2 仓库自检 | 被测仓库的 `checkCommand`、`testCommand`（Host 子进程，超时/输出上限/脱敏） | 每次升级 | 低–中 |
| L3 组合 | 临时 profile 装载被测插件 → `dsh --profile <tmp> --dump-config`，检查被跳过 bundle / 被拒行 | 升级候选与发布前 | 中（需 pnpm） |
| L4 启动 | 临时 profile + `dsh headless` 最小任务，真实 import/activate | 用户可选 / 发布前 | 高（模型调用） |
| L5 跨版本 | 临时装**目标 DSH 版本** + 被测插件 → L3/L4 | 发布前 / 用户手动 | 最高（下载 + 时间） |

另外必须有：

- **失败注入**：仓库不可写、非 git、命令超时、网络失败、`gh` 未登录、目标版本不可达、storage 写失败；
- **契约测试**：RPC 信封（`client-request`/`server-response`）、401/403、错误码稳定；
- **升级路径测试**：从旧版本插件数据（storage schema）迁移；
- **自身回归**：每次 DSH 出新版，用 L3/L4 验证 dsh-upkeep 自己仍能加载。

---

## 8. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | DSH 处于 rc 快速迭代期，内部 API/记录形状变化 | 高 | 中 | 核心逻辑 vendor；只用 `ctx.*` 稳定面；每次 DSH 升级跑 L3/L4 自检 |
| R2 | 「最新版」语义错误导致误报 | 中 | 中 | 通道 + 手动指定；`latest` 标签不参与决策；UI 明示比较对象与数据时间 |
| R3 | 无人值守 agent 无法审批 → 交付失败/卡住 | 高 | 中 | 交付移到 Host 半 + 人工确认；子 agent 只做编辑与测试 |
| R4 | 被测仓库不在 workspace，被沙箱挡住 | 中 | 高 | 统一"先注册 workspace 再开工"；worktree 放在允许根目录下；Host 半路径白名单 |
| R5 | LLM 迁移质量不稳定 | 中 | 高 | 机械候选 grounding + 强制测试 + diff 人工复核；默认不自动合并 |
| R6 | pnpm / CLI 实验台不可用 | 中 | 中 | M0 先验证；不可用则只保留 L1+L2 并明确告知 |
| R7 | 执行任意仓库的测试命令带来安全风险 | 中 | 高 | 仅限用户显式添加的仓库；命令来自配置而非模型；确认门 + 超时 + 输出脱敏 |
| R8 | 多仓库/大规模检查的性能与成本 | 低 | 中 | 并发上限、增量检查、缓存、按需检查 |
| R9 | 没有客户端半时用户收不到提示 | 中 | 低 | `dsh.client` 随包安装；同时提供 agent 工具与定时任务两条路径 |
| R10 | 用户误以为"合并 main 是安全的" | 中 | 高 | 默认 PR；合并需显式开关 + 每次确认 + 展示验证结果 |

---

## 9. 非目标（v1 明确不做）

- 自动修改或发布 registry 上的第三方包；不做自动 npm publish。
- 默认自动合并 main（只作为显式开启的能力）。
- 支持 GitHub 之外的托管（GitLab/Gitea 等）——留适配接口，不实现。
- 运行时热修复已安装 profile 里的 `node_modules`。
- 负责 DSH 自身升级（Desktop updater 的职责）。
- 云端/多人共享的监测服务（纯本地插件）。

---

## 10. 已确认的决策（2026-11-15）

| 决策点 | 结论 |
|---|---|
| 主入口 | **一级侧栏面板（`main` + `sidebar.panellist`，与 Plugins 同级）+ 设置页分页作为二级入口**；角标在 M1 末加 |
| 监测范围 | **本机仓库为主**；已安装但无仓库的插件只报告（提示升级到兼容版本 / 申请豁免），不改其 `node_modules` |
| 交付默认 | **默认创建 PR，不自动合并**；合并 main 仅作为显式开关 + 每次确认 |
| 下一步 | **先做 M0 + M1（脚手架 + 只读监测）** |

其余两项按本文推荐执行：目标版本 = 跟随 Desktop 通道 + 手动指定（D2）；兼容判定 **vendor** 一份实现 + 能力探测，不硬依赖 `@deepseek-ai/dsh-app-boot`（D9）。

开工顺序：M0 先验证三个前提——① `/api` RPC 通道在第三方插件里可用；② `dsh --dump-config` / `headless` 实验台可跑；③ pnpm 获取方式（`load_workspace_dependencies` 或 corepack）。任一不成立先调整方案再继续。

---

## 11. 实施进度

### M0 已完成（2026-11-15）

脚手架落地并已在**真实 desktop profile** 验证：

| 项 | 结果 |
|---|---|
| 工程规范 | 沿用 asc-hub：双 `tsconfig`、`dist/`、`cordis.patch.yml`、`dsh.bundle.patch` + `dsh.client`、`engines.dsh`、locale（en/zh）、icon、`docs/DETAIL.md` |
| Host 半 | `src/index.ts`（`inject: ['connection']`）→ `host/dispatch.ts`（Hub，action `status` / `bundles.list`）→ `host/rpc.ts`（`/api/upkeep/<action>`）+ `host/tool.ts`（`upkeep_status`） |
| Client 半 | `src/client.ts` 纯浏览器脚本：注册一级面板（`main` key + `sidebar.panellist` 图标）与设置页分页（id `dsh-upkeep`，order 40），两者共享同一 store，拉取 RPC 渲染版本/Profile/Bundle 表 |
| 构建与测试 | `npm test`：15 个单测通过（semver 比较、Config 归一化、Hub 状态投影、manifest/locale/patch 契约）+ `node --check dist/client.js` |
| 安装 | `plugin_manager install_bundle` → `application: applied`，bundle `@sleep9ull/dsh-upkeep@0.1.0`（`link:` 指向本仓库） |
| Host 激活 | `upkeep_status` 工具已注册并可调用，返回运行版 `0.2.2-rc.3`、profile `desktop`、207 个插件条目、28 个 bundle |
| Client 激活 | `cordis_inspect_query`（Client `Slots.listSubTree`）确认 `settings.plugins.tab` 的 occupant `dsh-upkeep` 与 `sidebar.panellist` 的 id `dsh-upkeep` 均为 `active: true`，`main` 面板注册后即可从侧栏打开 |
| 未验证 | 面板的**实际渲染**（需要刷新页面/截图；本会话无浏览器控制）。刷新 GUI 后侧栏应出现 Upkeep 图标，点击进入整页面板；设置页分页作为二级入口保留 |

### M0.1 主入口改为一级面板（2026-11-15）

用户反馈"设置页里的分页不够明显"，主入口调整为一级侧栏面板：

- 注册 `main`（key = `dsh-upkeep`）+ `sidebar.panellist`（id 相同，order 30，图标收 `{size, active}`），与 Plugins / Automation tasks 同级；
- 设置页分页保留为二级入口，页头加「打开面板」（`ctx.layout.selectPanel(PANEL_ID)`）；
- 两个入口共享同一个 store 与 dispatcher；客户端注入新增 `layout`；
- 文档同步：PLAN §5 / §10 / D6，AGENTS.md Layout 与验证步骤，README（英/中）与 DETAIL。

### M0.2 监测范围排除官方包（2026-11-15）

- 规则：`@deepseek-ai/*` 是 DSH 自身，随 DSH 版本走，不进监测列表（D13）。
- Host：`status` / `bundles.list` 过滤官方 bundle 与官方插件条目，返回 `excluded: { bundles, entries }`；工具描述同步说明。
- Client：摘要区新增「已排除」计数行 + 一句规则说明，保持"排除了什么"可见。
- 验证：新增单测覆盖"官方 bundle 不出现、`excluded` 计数正确"；真实 profile 重启后生效（Host 模块改动需重启 Harness）。

### M0.3 归属识别与维护结论（2026-11-16）

- 新模块 `src/host/owner.ts`：身份解析（配置 + `~/.gitconfig` + gh 登录）与归属判定（scope / author / author-email / repository / git remote），输出 `mine | other | unknown` + 证据 token。
- `status` / `bundles.list` 每个 bundle 增加 `owner` 与 `maintenance`；`ownership` 汇总 `mine / other / unknown / needsMaintenance` 与匹配到的身份（handles + 来源）。
- 维护判定（`mine` 才判定）：声明不兼容（`incompatible-version`）→ `attention`；插件行 `failed` → `attention`；`pending` → `attention`；无问题 → `ok`；运行态不可知 → `unknown`；非本人 → `not-mine`。
- 配置新增 `ownerHandles` / `ownerEmails` / `autoDetectOwner`（默认自动探测）；无身份时给出警告并全部显示未知。
- Client：摘要增加"我的插件 / 需维护 / 他人插件"，表格增加"归属 / 维护"两列，hover 显示证据与原因。
- 验证：新增 owner 单测 7 条、归属+维护集成单测 1 条，共 25 个单测通过；真机需重启后生效。
### M1 已完成（2026-11-16）

- `src/host/versions.ts`：补上 semver **范围满足**（comparator、caret、tilde、hyphen、x-range、partial、`||`、prerelease），对齐 DSH 的 `semver.satisfies(..., { includePrerelease: true })`。
- `src/host/compat.ts`：vendor 判据（`engines.dsh` 独占 → 否则 DSH peer → `workspace:` 改写 → 精确版本豁免；畸形字段抛 `MALFORMED_MANIFEST`）。
- `src/host/feed.ts`：npm packument + Desktop 通道映射（stable→latest、nightly→next、alpha→alpha）+ 最大 semver 回退 + 多 registry 回退；**不单独信 `latest`**。
- `src/host/state.ts`：`$DSH_HOME/upkeep/state.json`，版本化、原子写、检查历史上限与 feed 缓存。
- `status` / `check` / `bundles.list` 三个 action：`check` 刷新目标版本、逐 bundle 产出「声明层运行版 / 目标版判定 + 运行层行状态」并写一条报告；`status` 只读缓存，离线可用；启动 2s 后自动 check 一次（unref，可配置关）。
- 维护结论扩展：目标版本不兼容（且比运行版新）→ `will break on <version>`；运行版不兼容（未被豁免）→ 需维护。
- Client：元信息行加目标版本（含通道/stale）与上次检查；「立即检查」为主操作；行悬停显示不兼容需求明细。
- 测试：40 个单测通过（新增 range 3 组、compat 5 条、feed 3 条、state 2 条、check 集成 1 条）。
- 未验证：真机渲染（需刷新页面）；真实 registry 抓取（单测用注入 fetch，真机需重启 Host 后点「立即检查」验证）。
### M2 已完成（2026-11-16）

- `src/host/guides.ts`：解析安装版 `docs/upgrade-guide`（版本目录、frontmatter `description`、`## Change` / `## Migration`），按 `[from, to)` 选择；目标比安装版新时按 `dsh-v<target>` 标签从 GitHub 拉取缺失条目（上限 6 个版本 / 每版 40 条）。
- `src/host/surfaces.ts`：机械扫描插件包——manifest（包引用 / `dsh.client.inject`）、bundle patch（row id、inject、config key）、源码（`@deepseek-ai/*` import、`ctx.<service>`、事件、工具/命令名、slot id），有文件数、大小、深度上限。
- `src/host/match.ts`：按表面 token 在指南文本中的**标识符边界**命中打分（package/event/tool/slot/command 3、service 2、config/row 1），只保留有命中的条目并输出 `matchedSurfaces`。
- `check` 抓完目标版本后：一次指南加载 + 逐「我的插件」扫描匹配，把 `impact`（命中数、版本、Top 条目）写进快照与该次报告；`status` 复用最近报告的 impact，不重复扫描。
- 新 action `report.get`（面板/工具同一实现）：返回单个 bundle 的窗口、指南来源、匹配条目（含 Change/Migration 原文）与扫描清单；面板行悬停显示「N breaking changes (vX)」。
- 测试：新增 guides 3 条、surfaces 1 条、match 2 条、check/report 集成 1 条；总计 47 个单测通过。
- 限制：`persistence-schema.json` 差异未做；GitHub 拉取受网络与限额影响，失败时只用安装版指南并给出 warning；真机远端路径需重启后验证。
### M3 已完成（2026-11-16）

- `src/host/exec.ts`：Host 半唯一的子进程 seam（argv 数组、超时、输出上限、注入式 runner），供 worktree 与验证命令使用，测试可完全替换。
- `src/host/upgrade.ts`：`buildUpgradePrompt`（目标版本、命中的 Change/Migration、约束、验证命令，≤12k 字符）、`deriveVerifyCommands`（配置优先 → package scripts 的 check/test → build）、`inspectRepository`（git 根 + dirty 数）、`prepareWorkspace`（可选 `git worktree add -b upkeep/<bundle>-<stamp>`，默认直接用仓库）、`verifyWorkspace`（逐命令执行、非零/超时即失败）。
- 三个 action（`kind: 'write'`）：
  - `upgrade.prepare`：必须 `confirm: true`；校验归属（只允许自己的插件）、仓库、解析指南与命中、生成 prompt、注册 Workspace、写一条 run；返回 run（含 workspaceId/prompt）与 warnings。
  - `upgrade.verify`：必须 `confirm: true`；在 run 的 workspace 跑验证命令，记录每条结果与最终状态（verified/failed）。
  - `upgrade.runs`：列出已准备的 run 与结果。
- Client：我的插件行在「需维护或有命中的破坏性变更」时出现「升级」按钮 → 两次确认（升级 / 是否 worktree）→ 调 prepare → 用返回的 workspaceId + prompt 打开新会话（`ctx.uiWorkspace.startSession`）；面板顶部出现升级通知，带「验证」按钮调用 verify 并显示 `{ok}/{total}` 结果。
- 状态：`state.json` 增加有界 `runs`（默认 10 条），记录 prompt、workspace、验证结果。
- 测试：升级单测 5 条 + Hub `upgrade.prepare`（confirm 门、worktree、workspace 注册、prompt 内容）与 `upgrade.verify` 集成 1 条；全套 53 个单测通过。
- 未做/边界：PR 与合并留给 M4；L3/L4（`--dump-config`、headless 启动 oracle）未接入；Session 启动依赖 workspaceRegistry（缺失时报 `WORKSPACE_UNAVAILABLE`）；真机路径需重启 Host + 刷新页面验证。
### M4 已完成（2026-11-16）

- `src/host/deliver.ts`：交付 seam——`readDeliveryPreview`（分支 / dirty / ahead / diffstat / gh 可用与登录 / remote）、`commitWorkspace`（`git add -A` + commit，干净树不算错误）、`pushBranch`、`createPullRequest`（`gh pr create`，已存在则复用 URL）、`mergePullRequest`（`--merge`/`--squash`）、`removeWorktree`、`buildDeliveryText`。
- Actions：`delivery.preview`（read）、`delivery.create-pr`（write，confirm）与 `delivery.merge`（write，confirm + `allowMerge`）。create-pr 顺序为 commit → push → gh pr create，任一步失败都会把 `delivery.error` 落库；merge 要求已有 PR。
- 配置：`defaultBaseBranch`（默认 `main`）、`allowMerge`（默认 `false`，每次合并仍需单独确认）。
- 状态：run 增加 `delivery`（stage / commit / branch / prUrl / mergedAt / error）。
- Client：验证成功后通知出现「创建 PR」；创建成功后显示 URL，并在 `allowMerge` 时出现「合并」；两步都带二次确认。
- 测试：delivery 单测 5 条 + Hub 交付链路（confirm 门、commit/push/PR、merge、MERGE_DISABLED）2 条；总计 60 个单测通过。
- 边界：forge 默认未挂载，PR 创建固定走宿主 `gh`；worktree 清理已实现但未接 UI；真机需重启 Host、`gh` 已登录、base 分支本地存在（否则 preview 给 warning）。
### M5 已完成（2026-11-16）

- `src/host/schedule.ts`：结构化读取 `ctx.schedule`，把周期检查映射成 `{title, prompt, timing:{kind:'every', every_seconds}, target:{kind:'new_once', create:{cwd}}}`；间隔钳制在 60 秒 ~ 30 天；`listUpkeepTasks` 只保留标题以 `Upkeep` 开头的任务。
- 两个 action：`schedule.create`（write，confirm；`SCHEDULE_UNAVAILABLE` 明确降级）、`schedule.list`（read）。
- 配置：`scheduleCwd`（新建会话的项目目录，空则 `$DSH_HOME`）、`scheduleIntervalHours`（默认 24，1–720）。
- 投递 prompt 只做检查与汇报，明确要求本轮不修改任何文件；升级仍由面板上的人工按钮触发。
- Client：面板操作区新增「定时检查」，二次确认后创建并提示任务标题；任务本身在 DSH 的 Automation tasks 页面管理。
- 测试：schedule 单测 5 条 + Hub（confirm 门、请求形状、列表过滤、SCHEDULE_UNAVAILABLE 降级）2 条；总计 67 个单测通过。
- 边界：未做暂停/删除（交给 DSH 自带任务页）；投递需要 Host 在运行；目标会话被归档会随 DSH 语义删除任务。
### M6 已完成（2026-11-16）

- **并发保护**：`check` 与 `upgrade.prepare` 互斥（`BUSY`），避免交错写状态文件。
- **能力探测**：快照新增 `capabilities`（schedule / workspaceRegistry），面板在服务缺失时禁用对应按钮并给出说明；`SCHEDULE_UNAVAILABLE` / `WORKSPACE_UNAVAILABLE` 保持显式降级。
- **配置契约**：`test/config.test.ts` 覆盖全部配置默认值与边界（target 通道、TTL、保留条数、runs、base 分支、allowMerge、schedule、owner 列表、verifyCommands 多行解析）。
- **i18n 契约**：manifest 测试比较 en / zh 字典键集合，防止文案单边漂移。
- **发布元数据**：`0.1.0` → `0.1.2`（M1–M6 这一批改动合成一个补丁版本，不按里程碑跳大版本），新增 `CHANGELOG.md`（M1–M6 摘要），`files` 纳入变更记录与脚本。
- **可重复全量测试**：`scripts/full-test.mjs` + `npm run verify:full`——单测/契约 → 包元数据 → `dsh --profile desktop --dump-config` 组合配置（确认 upkeep row 进入 Loader）→ 真实 npm registry 目标版本读取；环境不支持时标记 `skipped` 而不是静默通过。
- 测试：70 个单测通过；全量脚本结果见下。







### M0.4 归属分组视图（2026-11-16）

- 面板把 bundle 列表拆成两个视觉分组：**我的插件**（`owner.status === 'mine'`）在上，**其他插件**（他人或归属未知）在下；每组独立表头、计数与空态提示。
- 两组合用同一张表结构（列：名称 / 版本 / 状态 / 归属 / 维护 / 行数），"其他插件"的维护列显示 `—`。
- 契约测试断言构建产物里存在分组容器与两组标题键；客户端改动只需刷新页面。

### M0.5 「其他插件」默认折叠（2026-11-16）

- 归属分组的「其他插件」默认收起，只显示标题、计数与提示；点击标题展开，再点收起。
- 选择写入 `localStorage` 的 `dsh.upkeep.othersExpanded`，刷新后保持；私密模式或存储不可用时退回内存状态，不报错。
- 折叠状态不请求任何数据、不影响 Host；「我的插件」分组始终展开。
- 测试：契约测试断言构建产物包含折叠按钮类名与存储键。

### M0.6 主界面设计重构：服务台账（2026-11-16）

把面板从"表格 + 读数条"重做为**运维台账（service ledger）**，方向与依据：

- **状态句当主角**：一句话回答"我的插件要不要维护"（全健康 / 有 N 个需维护 / 尚未识别），使用宿主 locale 的 `{param}` 插值；有需维护项时整句转为状态错误色。
- **元信息行**：DSH 版本 / profile / bundle 数 / 插件条目数 / Upkeep 版本 / 上次检查，用竖发丝线分隔的结构化事实，不做 KPI 卡片（避免"大数字 + 标签"的通用仪表盘套路）。
- **台账表格**：发丝线行、等宽 + 等宽数字的版本列、需维护行左侧 2px 强调线；列按组裁剪——「我的插件」不显示归属列，「其他插件」不显示维护列。
- **页脚**：官方包排除规则与排除计数，保持"排除了什么"可见。
- **Base UI 规范**：按钮/折叠/焦点环手写遵循宿主规范（`aria-expanded`、`aria-busy`、`:focus-visible` 2px 品牌色环、`prefers-reduced-motion` 关闭动效）；不引入外部组件库（D15）。
- 文案同步清理：状态句提供单复数变体，移除不再使用的旧键。
- 验证：`npm run verify` 26 个单测通过；契约测试新增 `upkeep-status` / `upkeep-meta` / `upkeep-footer` / `upkeep-table-scroll` 断言；实际渲染需刷新页面确认。

### M0.7 台账列裁剪（2026-11-16）

- 去掉 Owner 列：归属已由分组标题与"其他插件"的"他人 N · 归属未知 M"拆分表达，列里重复。
- 去掉 Rows 列：它是该 bundle 声明的插件条目（Loader row）数量（`dsh-base` 99、`dsh-web-app` 103，单插件 bundle 通常为 1），对维护判断没有增量；改放在 Bundle 单元格的悬停提示（"N 插件条目 · 安装来源"）。
- 台账因此只剩四列（我的：Bundle / 版本 / 状态 / 维护；其他：Bundle / 版本 / 状态），名称列获得剩余宽度。
- 清理：删除 `ownerChip`、对应字典键与 `.upkeep-num` / `.upkeep-rows` 样式。

**真机发现（可直接作为 M1 第一批监测对象）**：当前 profile 已有两个真实的不兼容 bundle——

- `@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1`：`error.code = incompatible-version`
- `dsh-worktrace@0.2.1`：`error.code = incompatible-version`

M1 实现"声明层重算 + 受影响条目定位"时，应能各自解释**为什么**不兼容（哪个 `engines.dsh` / peer 范围拒绝了 `0.2.2-rc.3`），并给出"升级插件版本 / 改代码 / 申请豁免"三条出口。

### 三个前提的当前结论

| 前提 | 结论 |
|---|---|
| ① `/api` RPC 通道 | ✅ 已验证（安装后工具与客户端分页同时激活） |
| ② `dsh` CLI 实验台 | ✅ 已验证可运行（`ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" "$DSH_INSTALL_DIR/lib/bin.js" --version` → `0.2.2-rc.3`，支持 `--dump-config` / `headless`） |
| ③ pnpm | ⚠️ 不在 PATH，但 Desktop 的 launcher 自带 package manager，`install_bundle` 正常完成；跨版本实验台如需独立 pnpm，用 `load_workspace_dependencies` 提供的路径 |

### 下一步：M1（只读监测）

1. `src/host/compat.ts`：vendor 兼容评估（`engines.dsh` 优先、peer 回退、`includePrerelease`、`workspace:` 改写）；
2. `src/host/state.ts`：`ctx.storage.domain` 持久化 `MonitorEntry` / `CompatReport`；
3. `src/host/feed.ts`：目标版本 feed（npm packument + 通道模型 + 缓存/离线）；
4. 自动发现：`listBundles()` → 逐行 `package.json`，与 `readPluginInventory` 运行层合并；
5. UI：状态徽标、影响原因、手动检查、历史；侧边栏角标（M1 末）。
