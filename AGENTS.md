# AGENTS.md

`dsh-upkeep` 是一个 DeepSeek Harness 插件：帮插件作者发现自己的插件与当前/即将发布的 DSH 不再兼容，并把一次不兼容变成定向升级、自动验证和一个人工确认的 PR。Host 半只实现每个操作一次；Web 面板和 agent 工具是它的两个适配器。

它同时是一门"关于 DSH 契约的工程"：判据必须与 DSH 自己的判定一致，结论必须有安装版的证据，写操作必须有人在回路里。本文就是这些契约的落地规则。

## Read first

| 何时读 | 文档 |
|---|---|
| 要改**范围、优先级、验收标准**，或怀疑某个设计决定 | [docs/PLAN.md](docs/PLAN.md) —— 范围与设计决策（D1–D15）的唯一来源；改范围先改这里 |
| 要断言**任何 DSH 行为**（服务、事件、字段、版本语义、CLI 参数） | [docs/EVIDENCE.md](docs/EVIDENCE.md) —— 已核实事实；新结论先补证据再写代码 |
| 要改 **Host↔Client 线协议**（路由、信封、错误码） | [src/host/rpc.ts](src/host/rpc.ts) 头部注释 —— 线协议当前权威；若它长大到需要独立文件，拆成 `docs/CONTRACT.md` 并在两处同步 |
| 要新增/修改 **Host 插件面**（manifest、patch、locale、icon、导出） | `dsh-doc` 技能的 `references/host-plugin.md`、`references/ui-plugin.md`、`references/plugin-development.md` |
| 要在 **Web 面板**加 slot / 组件 / 样式 | `dsh-doc` 的 `references/practices.md`（UI 一节）与 `cordis_inspect_query` 的实时 Slot 树 |
| 要判断**升级后 DSH 的破坏性变更** | 安装版 `docs/upgrade-guide/`；未安装版本按 GitHub tag `dsh-v<version>` 取 |

**两个前提先记住**：运行中的 DSH 是唯一权威（本仓库按 **0.2.2-rc.3** 写作）；DSH 内部包没有稳定性承诺，凡触及内部 API 的结论都必须有证据与降级方案。

## 当前状态

进度、验收标准和已确认决策只在 [PLAN §10–§11](docs/PLAN.md) 维护：M0（脚手架 + 真机激活）、M1（兼容监测）、M2（迁移报告）、M3（定向升级与验证）已完成；M0–M6 全部完成（0.1.0，尚未发布）。本文件只写不随里程碑变化的规则，避免两处状态各自漂移。

## Layout

| 路径 | 是什么 |
|---|---|
| `src/index.ts` | Host 入口：`apply(ctx, config)`，`inject = ['connection']`，建 Hub、注册 RPC 与工具，全部经 `ctx.effect` 拥有。 |
| `src/host/dispatch.ts` | **唯一操作实现**：`Hub`、`actions` 表、`kind: 'read' \| 'write'`、配置归一化、状态投影。 |
| `src/host/rpc.ts` | 面板适配器：每个 action 一条 `POST /api/upkeep/<action>`；信封校验、错误封装、owner 栅栏。 |
| `src/host/tool.ts` | 模型适配器：`upkeep_status` 工具，同一 Hub；写操作将来经 `tools/pre-execute` 走审批。 |
| `src/host/types.ts` | 对 Harness 服务的**结构化类型**（`ctx.get(...)` 防御式读取），不 import 内部包。 |
| `src/host/versions.ts` | semver 解析、比较与**范围满足**（comparator、`^`、`~`、hyphen、x-range、`||`、部分版本，含 prerelease），对齐 DSH 的 `semver.satisfies(..., { includePrerelease: true })`。 |
| `src/host/owner.ts` | 归属判定：从包 scope / author / repository / 本地 checkout 与 git remote 取证据，与本地身份（配置、`~/.gitconfig`、gh 登录）匹配，产出 `mine/other/unknown` + 证据 token。 |
| `src/host/compat.ts` | vendor 的兼容判据：`engines.dsh` 独占、否则 DSH peer、`workspace:` 改写、精确版本豁免；畸形 manifest 抛 `MALFORMED_MANIFEST`。 |
| `src/host/feed.ts` | 目标版本感知：npm packument、Desktop 通道 → dist-tag 映射、最大 semver 回退（`latest` 标签不作为唯一依据）、多 registry 回退。 |
| `src/host/state.ts` | `$DSH_HOME/upkeep/state.json`：版本化、原子写、有界的检查历史与版本 feed 缓存。 |
| `src/host/guides.ts` | 迁移指南：安装版目录解析、`[from,to)` 选择、固定 `## Change` / `## Migration` 章节；目标更新时按 `dsh-v<target>` 标签拉取缺失版本（有上限）。 |
| `src/host/surfaces.ts` | 插件表面机械扫描：manifest、bundle patch、源码里的包/服务/事件/工具/命令/slot/config/row；文件数、大小、深度有界。 |
| `src/host/match.ts` | 指南条目 × 表面 token 的机械匹配与打分，只留下有命中的条目；`summarizeMatches` 产出面板用的 impact。 |
| `src/host/exec.ts` | Host 半唯一子进程 seam：argv 数组、超时、输出上限、可注入 runner（worktree 与验证共用）。 |
| `src/host/upgrade.ts` | 升级闭环：prompt 组装、验证命令推导、git 仓库探测、worktree 准备、逐命令验证。 |
| `src/host/deliver.ts` | 交付：preview（分支/dirty/ahead/diff/gh 状态）、commit、push、`gh pr create`、`gh pr merge`、worktree 清理；全部有界、argv 数组、确认门。 |
| `src/host/schedule.ts` | 周期检查：结构化读取 `ctx.schedule`，映射 `every` 定时与 `new_once` 目标；间隔钳制、任务标题前缀过滤。 |
| `scripts/full-test.mjs` | 可重复全量测试：单测/契约 → 包元数据 → CLI `--dump-config` 组合配置 → 真实 registry 目标版本；不支持的环境记为 skipped。 |
| `src/client.ts` | Web 半：**一段编译脚本**（`module: none`，无 import/export），注册一级侧栏面板（`main` key + `sidebar.panellist` 图标，id `dsh-upkeep`）与 Plugins 设置页分页（同一 id，二级入口）；React 由 loader 的 `require` 提供。 |
| `locale/en.json`、`locale/zh.json` | 插件展示元数据（`meta.title/description/detail`）。面板内文案在 `src/client.ts` 的 `en`/`zh` 字典。 |
| `cordis.patch.yml` | bundle patch：插入 row `upkeep`（`@sleep9ull/dsh-upkeep`）及其 config。 |
| `test/*.test.ts` | 对 `dist/` 运行的单测（`npm test` 先构建）；`test/panel-render.test.ts` 在 VM 里跑 `dist/client.js` 并用 react-dom/server 真渲染面板，抓类型检查抓不到的运行时错误。 |
| `docs/` | PLAN（范围/决策）、EVIDENCE（DSH 事实）、DETAIL（用户可见说明）。 |
| `README.md` / `README.zh.md` | README 以英文为默认（`README.md`），中文版 `README.zh.md` 顶部互相切换；只写已交付与明确计划的能力。 |
| `LICENSE` | MIT；与 `package.json` 的 `license` 字段一致。 |
| `dist/`、`dist-test/` | 构建产物，git 忽略。 |

新增或改名 Host 模块时，同一改动内更新本表与 PLAN 的架构图。

## Invariants

不许回退；每条都有廉价检查，声称完成前先跑它。标 **(M1+)** / **(M3+)** 的条目对当前 M0 代码是实现约束而非既有行为——开始对应里程碑时按它验收。

1. **两扇门，一次实现。** 行为只写在 `src/host/dispatch.ts`（及它委派的模块）；`rpc.ts`、`tool.ts`、`client.ts` 只做翻译。*检查：* 同一 operation 经任一门可用，且为它加能力时没有改两个适配器。
2. **只读默认，写必确认。** 每个 action 显式声明 `kind`；`write` 需要用户显式确认，工具侧另经 `tools/pre-execute` 询问。*检查：* 未确认的写调用返回稳定错误码，面板弹出确认，模型路径出现审批。
3. **交付由人确认。** 推送与 PR 由 Host 在确认后执行，合并 main 是显式开关 + 每次确认；无人值守的子 agent 只做编辑与测试。*检查：* 默认路径只产出 PR；关闭 `allowMerge` 时 `delivery.merge` 返回 `MERGE_DISABLED`。
4. **证据优先。** 任何 DSH 行为断言都能指到安装版文件与行号，并写入 EVIDENCE.md；凭记忆的结论不算。*检查：* 新断言在 EVIDENCE.md 有对应行，且标注了版本。
5. **判据与 DSH 一致（M1+）。** vendor 的 `compat.ts` 逐条对齐 `app-boot` 语义：`engines.dsh` 存在则独占判定；否则看 `@deepseek-ai/dsh*` peer；`includePrerelease: true`；`workspace:^|~|*` 改写为运行版本；空/非法范围判不满足；豁免只认精确 `name@version` → 精确 DSH 版本。*检查：* 与 DSH 源码对照的表格化单测；DSH 升级时重跑对照。
6. **运行版本从 profile 取。** 用 `ctx.profileContext.installAnchor` 读运行中 `@deepseek-ai/dsh/package.json`；`DSH_INSTALL_DIR` 只是 shell 工具变量。*检查：* `src/` 里没有读该环境变量的 Host 代码；状态接口返回 `runtimeVersion`。
7. **Host 半零运行时依赖。** `src/` 只用 `node:*` 与相对模块；第三方包只出现在 devDependencies。*检查：* `package.json` 的 `dependencies` 为空；`dist/` 可直接被 link 安装加载。
8. **Client 是一段编译脚本。** `src/client.ts` 无 `import`/`export`、无 JSX、无 `@deepseek-ai/*` 引用；module id 等于包名；IIFE 带重复注册保护；颜色与间距只用主题 token（`--dsw-alias-*`、`--dsw-radius-*`），`icon.svg` 的插画配色除外；用户可见文案全部走 `ctx.locale` 的 `en`/`zh` 字典。*检查：* `tsc -p tsconfig.client.json`、`node --check dist/client.js`、`test/manifest.test.ts`。
9. **展示元数据齐备。** 两个 locale 都有 `meta.title/description/detail`；`icon.svg` 为原创；`files` 覆盖全部运行时文件（含 `dist`、patch、locale、icon、detail）。*检查：* manifest 契约测试。
10. **监测是拉取式的（M1+）。** DSH 没有 Host→浏览器推送；状态由面板按需拉取，后台检查把结果写进存储，通知靠客户端半渲染。*检查：* 关闭面板时检查仍可运行并落库；打开面板后无需重启即可读到。
11. **升级在会话里发生。** 被测仓库的代码由会话中的 agent 编辑（可选 worktree）；Host 负责准备、验证、交付。已安装 profile 的 `node_modules` 是只读输入。*检查：* 升级运行记录带 `sessionId`；Host 代码没有直接写被测仓库源文件的路径。
12. **不虚构兼容结论。** 声明层、运行层、历史层分开呈现；读不到就显示未知并附原因，三种状态不合并成一个布尔值。*检查：* 断网/缺服务时 UI 显示"未知 + 原因"而不是"兼容"。
13. **监测范围排除官方包。** `@deepseek-ai/*` 属于 DSH 本身、随 DSH 版本走，不进监测列表；状态与工具结果用 `excluded` 报告排除了多少 bundle / 条目，而不是静默丢弃。*检查：* `bundles` 里没有该 scope 的项，且 `excluded` 的计数与 `listBundles` / `listPlugins` 的差值一致。
14. **归属判定有证据、可配置、未知就是未知。** `mine/other/unknown` 只能由 `src/host/owner.ts` 产出；每条判定带证据 token（`scope:`、`author:`、`repo:`、`remote:`、`local-checkout`、`no-metadata`），身份来自 `ownerHandles`/`ownerEmails` 配置、`~/.gitconfig` 与 gh 登录；没有信号时保持 `unknown`，绝不默认"是我的"。*检查：* owner 单测覆盖四类证据与"无元数据不猜测"；无身份时状态带警告且 `ownership` 全为 unknown。
15. **目标版本不迷信 `latest`。** 目标版本只来自「配置的精确版本 / 桌面通道映射的 dist-tag / 已发布最大 semver」，`dist-tags.latest` 在 rc 周期会滞后；读到缓存标记 stale，读不到就是未知。*检查：* feed 单测覆盖 channel 映射、最大 semver 回退与 registry 失败回退。
16. **报告只呈现有命中的条目。** `report.get` 与 `impact` 的每条命中都必须能指回具体的 `matchedSurfaces`；扫描与远端拉取都有上限，失败时降级为安装版指南并给出 warning，不假装完整。
17. **同一时间只跑一个 check 或 upgrade。** 长操作必须先拿互斥锁，第二个调用返回 `BUSY`；状态文件只由一个操作写入。*检查：* dispatch 的 `exclusive()` 包裹 check 与 upgrade.prepare；并发调用返回稳定错误码。

## 新增一个 operation

按顺序做，每步都有验收点。

1. **契约。** 在 `src/host/rpc.ts` 头部与（若已拆分）`docs/CONTRACT.md` 写明：action 名、`kind`、input、返回、错误码。*完成：* 面板与工具对同一 action 的含义完全一致，input 没有未定义字段。
2. **Dispatcher。** 在 `src/host/dispatch.ts` 的 `actions` 表加实现，输入校验放在这里；复杂逻辑拆到 `host/` 下的模块并在 §Layout 登记。*完成：* 不改 `rpc.ts`/`tool.ts` 就能被 `hub.call` 调用。
3. **适配器。** 读操作默认对两扇门开放；写操作在工具描述与 `tools/pre-execute` 里补审批，在客户端补确认对话框。*完成：* `Tool.listTools` 能看到新 action；未确认写调用被拒。
4. **测试。** 在 `test/` 加单测（成功、降级、错误码各一）；涉及 DSH 事实的用例附 EVIDENCE 行号。*完成：* `npm test` 通过。
5. **真机验证。** 走 §安装与验证；Host 变化需要重装/重启，Client 变化刷新页面。*完成：* 面板显示真实数据，Slot 树里 occupant 为 `active`。

## 安装与验证

用 `plugin_manager`，不用 shell 复现安装。

1. `plugin_manager` → `install_bundle`，target = 本仓库绝对路径（`/Users/jinchunxu/dev/dsh-upkeep`）。接受审批失败并请用户操作，不绕过。
2. 读结果：`application: applied` 才算生效；`failed` / `overridden` / `restart-required` 与 `warnings` 原样上报。
3. 用 `cordis_inspect_query` 验证活面：
   - Host `Tool.listTools` → `upkeep_status` 在列；
   - Host `Config.listConfigs`（按 name 过滤）→ `upkeep` 行存在；
   - Client `Slots.listSubTree` → `sidebar.panellist` 的 id `dsh-upkeep`、`main` 的 key `dsh-upkeep`、`settings.plugins.tab` 的 occupant `dsh-upkeep` 三者都 `active: true`。客户端查询超时通常是页面未连接：刷新 GUI 再试。
4. 路由自检：**面板能拿到数据才是路由存在的证据**。未认证的 `POST /api/upkeep/status` 会返回 `401`，但那只证明 `/api` 栅栏生效——任意 `/api/*` 路径（包括不存在的）未认证都返回 401，所以 401 不能证明路由已注册。两条信号都要看。
5. 真实数据自检：调用 `upkeep_status`，确认 `dsh.runtimeVersion` 与安装版一致、`bundles` 非空。
6. 只有面板渲染出真实状态后才算视觉验证完成；渲染崩溃会在控制台出现 `slot entry crashed in '<slot>'`，读它。

**linked 安装直接服务仓库里的 `dist/`**：改完先 `npm run build`（或 `npm test`），Host 侧替换需要重启 Harness，Client 侧刷新页面；两者都没更新时先怀疑这一点。

## 常见坑

- **不兼容的插件行没有事件、没有记录。** 启动时被置为 `disabled:true`，只打一行 stderr，`listPlugins()` 里和用户手动禁用无法区分。兼容状态一律自己重算，别订阅"不存在的事件"。
- **目标是"最新版"时 `dist-tags.latest` 会骗人。** 实测 `latest=0.2.2-rc.1` 而安装版 `0.2.2-rc.3` 是 `next`；比较用最大 semver + 通道标注。
- **npm 包不带 docs。** 未安装版本的升级指南只能按 GitHub tag 取；`docs/persistence-schema.json` 是唯一的机器可读指纹。
- **被委派子 agent 的审批固定为 `never`。** 它适合改代码、跑测试；`git push`、`gh`、安装依赖这类越界动作放到 Host 确认门之后。
- **`ctx.forge` 没有创建 PR。** 创建 PR 是 `gh pr create`；forge 只用于跟踪/合并（且 forge 系列默认未挂载，按能力探测降级）。
- **不要改 profile 的 `node_modules`。** 被测对象是本机 git 仓库；已安装副本只读。
- **实验包默认不在 desktop profile**（worktree/forge）。用能力探测 + Host `git`/`gh` 降级，别硬依赖。
- **客户端半不是可选装饰。** 没有它就没有角标与列表，后台检查的结果用户看不到。
- **`.asar` 里的源码**：`read` 工具能读；原生 `ls`/`grep`/`node` 不能，需 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e '...'`。
- **CLI 实验台**：`ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" "$DSH_INSTALL_DIR/lib/bin.js" --version`；`--dump-config` 组合 profile，`headless` 真实启动。**Desktop 运行时 `--profile desktop` 被 Electron 独占**，dump 会报 "managed exclusively by the Electron application"——实验台请用临时 `DSH_HOME` 或非 desktop profile。`pnpm` 不在 PATH，Desktop 的 launcher 安装自带；实验台需要时用 `load_workspace_dependencies`。

## DSH 升级时（dogfooding）

DSH 发布新版本后，本项目自己就是第一个被监测的插件。顺序固定：

1. 用安装版 `docs/upgrade-guide/` 从**运行的旧版本**读到**目标版本**，只读 `[旧, 新)` 的条目。
2. 逐条对照本仓库的 surface：`engines.dsh`、peer、patch 的 row/inject/config、`ctx.*` 用法、客户端 slot id、RPC 路由、持久化 schema。
3. 修改后跑 `npm run verify`，再走 §安装与验证；插件自身必须仍能加载，否则先修它。
4. 更新 EVIDENCE.md 的版本标注与受影响行；把这次的破坏写进 PLAN §风险登记（如果它改变设计假设）。

## 完成定义

一个改动算完成，当且仅当：

- `npm run verify` 通过（类型检查 + 构建 + 全部单测 + 客户端脚本语法检查）；
- 涉及的 DSH 事实在 EVIDENCE.md 有出处，涉及的范围/决策在 PLAN.md 已同步；
- 真机验证的层级与结论写在交付说明里；未验证的部分明确说出来（例如"渲染未验证，需刷新页面确认"）；
- 写操作有确认门，读操作没有副作用。

## 契约归属

| 内容 | 唯一来源 |
|---|---|
| 范围、里程碑、设计决策 | `docs/PLAN.md` |
| DSH 行为事实与版本 | `docs/EVIDENCE.md` |
| Host↔Client 线协议 | `src/host/rpc.ts` 头部（拆分后为 `docs/CONTRACT.md`） |
| 工程规则与安全边界 | 本文件 |
| 用户可见功能说明 | `docs/DETAIL.md`（只写已验证的行为） |

代码与契约冲突时，报告冲突并先改契约，不要用代码反向"解释"契约。
