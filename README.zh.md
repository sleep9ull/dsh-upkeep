# dsh-upkeep

[English](README.md) · **简体中文**

![Status](https://img.shields.io/badge/status-M0%20complete-blue)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-4b8bbe)
![License](https://img.shields.io/badge/license-MIT-green)

**为 [DeepSeek Harness](https://www.deepseek.com/harness/) 插件作者准备的兼容性管家。**

> DSH 迭代很快。一个插件不再声明兼容当前版本时，它不是"有点小问题"——DSH 会直接拒绝加载它，对应的行被静默禁用，唯一的痕迹是 stderr 上的一行日志。搞清楚**为什么**、再修好它，每个版本都要手工来一遍。
>
> `dsh-upkeep` 把这条链路闭合：持续监测你维护的插件，在你的用户之前告诉你哪里坏了，并把一次不兼容变成定向升级、自动验证和一个人工确认的 PR。

`dsh-upkeep` 是一个面向插件作者的 DSH 插件，负责三件事：

- **兼容性监测** —— 维护一份插件监测清单，逐个报告它是否满足当前运行的 DSH，以及你即将升级到的下一个 DSH。
- **一键定向升级** —— 从 DSH 的迁移指南里挑出真正命中你插件的破坏性变更，让编码 agent 在独立会话（可选 git worktree）里按指南修改，自动验证，最后开一个 PR 给你 review。
- **定时巡检** —— 帮你创建周期性的兼容性检查任务，DSH 发新版本时无需打开应用也能被发现。

两扇门，一套实现：面板能做的，agent 通过工具也能做；agent 能做的，面板里都看得见。

## 状态

| 能力 | 状态 |
|---|---|
| 侧栏固定的 **Upkeep 面板**（与 Plugins 同级）+ **设置 → Plugins** 分页、状态快照、归属与维护判定、`upkeep_status` 工具 | **已交付（M0）** |
| 目标 DSH 版本感知、声明层判定（运行版 + 目标版）、检查历史、**立即检查** | **已交付（M1）** |
| 迁移指南匹配与单插件破坏报告 | **已交付（M2）** |
| 会话或 worktree 中的一键升级、分层验证 | **已交付（M3）** |
| 人工确认的 PR / 合并交付 | **已交付（M4）** |
| 通过 DSH 定时任务做周期检查 | **已交付（M5）** |
| 加固、配置/i18n 契约测试、发布说明、可重复全量测试脚本 | **已交付（M6）** |

范围、设计决策与验收标准见 [docs/PLAN.md](docs/PLAN.md)。本 README 只描述**当前已交付**的能力与**明确计划**的能力。

## 安装 / 更新

### 从 Plugins 页面安装

`dsh-upkeep` 尚未发布到 npm registry，请从本地 checkout 安装：

```sh
git clone https://github.com/sleep9ull/dsh-upkeep.git
cd dsh-upkeep
npm install
npm run build
```

然后在 DSH 网页版或桌面版打开 **设置 → Plugins → Add plugin**，选择该目录并安装。bundle 以 link 方式安装，直接服务构建产物 `dist/`——改完 Host 代码需要重新构建并重启 Host，改完客户端代码刷新页面即可。

### 使用 `dsh` CLI 安装

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-upkeep
```

`<profile>` 用你运行 Web UI 的那个（npm 安装用 `web`，桌面版用 `desktop`）。重启该 profile 或等 HMR 重载。

### 更新

拉取最新代码后执行 `npm install && npm run build` 并重新加载。后续版本可以直接从 registry 按包名安装。

## 使用方法

| 入口 | 作用 |
|---|---|
| **Upkeep 面板** | 左侧面板列表里固定的图标，与 **Plugins**、**Automation tasks** 同级。点击进入整页：运行中的 DSH 版本、当前 profile、插件条目数，以及每个已安装 bundle 的版本、状态、归属与维护结论。**刷新** 重新读取。 |
| **Upkeep 分页** | **设置 → Plugins → Upkeep** 显示同一视图，方便你在管理插件时就近查看；页头的「打开面板」直达一级面板。 |
| **`upkeep_status` 工具** | 会话内的 agent 读取同一份快照；传 `action: "bundles.list"` 只取 bundle 列表。只读：不安装、不改文件、不联网。 |

### Upkeep 面板

面板先回答一个问题：**这个安装到底在运行什么，它加载了哪些插件？**

- 顶部一句话直接回答维护问题——「你的 2 个插件全部正常」或「你的 2 个插件中有 1 个需要维护」；出现需维护项时整句转为错误色。
- 一行元信息承载运行中的 DSH 版本、profile、bundle 与插件条目数、Upkeep 版本、上次读取时间。
- 列表是台账而不是卡片：发丝线行、等宽版本号、需维护行左侧 2px 强调线。
- bundle 列表按归属拆成两个视觉分组：**我的插件**在上（按本机身份匹配），**其他插件**在下（他人或归属未知，**默认折叠**——点标题展开，选择会被记住）。
- 两组各自裁剪列：**我的插件** = Bundle / 版本 / 状态 / 维护；**其他插件** = Bundle / 版本 / 状态，分组标题右侧给出"他人 N · 归属未知 M"的拆分。悬停在行上可以看到插件条目数与安装来源，悬停在维护结论上可以看到原因。
- 归属是**推断**而不是假设：用包的 scope、`author`、`repository`、本地 checkout 的 git remote，与你的身份匹配——插件配置里的 `ownerHandles` / `ownerEmails`，加上 `~/.gitconfig` 的 name/email 和已登录的 `gh` 账号。没有任何可识别信号的插件保持 **未知**。身份取的是**运行它的那台机器**：换一个开发者的电脑安装，它会识别出那个人的插件并归为"我的"，同一个插件服务所有作者。
- 维护结论只对**我的**插件计算：与当前 DSH 声明不兼容、或某个插件行加载失败 → **需维护**；否则显示 **正常**（声明范围的前瞻判定随 M1 到来）。
- 官方 `@deepseek-ai/*` 包属于 DSH 本身，不会出现在监测列表里；摘要区会说明排除了多少 bundle 与插件条目，不会让人以为漏了数据。
- 某个事实读不到时，用行内提示说明原因（例如 plugin-manager 服务未挂载）。读不到的值显示为"未知 + 原因"，不做猜测。

### `upkeep_status` 工具

工具是模型侧的同一扇门，调用的是面板所用的同一个 dispatcher。例如直接问 agent *"我哪些插件加载失败了？"*，它读到的是与面板里完全相同的那份快照。

## 兼容性如何判定

DSH 只有一个官方判据，Upkeep 会照抄它，而不是另发明一套：

1. **声明层** —— 插件自己的 `engines.dsh` 范围单独决定；没有它时，每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都必须满足。预发布版本参与比较，`workspace:^|~|*` 表示当前运行版本。不满足时，只有 profile 的 `compatibility.json` 里针对精确版本的豁免才算数。
2. **运行层** —— 插件行的实时 fiber 阶段与诊断信息，用于抓"范围满足但 import 或 apply 失败"的插件。
3. **历史层** —— Upkeep 自己记录的"这个插件从哪个 DSH 版本开始不匹配"，DSH 本身不保留这段历史。

因为判据来自你的插件 manifest 和运行版本，Upkeep 还能更早回答一个更有用的问题：**这个插件在下一版 DSH 上还能加载吗？** 正是这个前瞻能力，把"发布当天的意外"变成一件可以安排时间处理的事。

### 迁移报告

一次 `check` 还会读取运行版与目标版之间 DSH 的升级指南，扫描每个属于你的插件实际用到的面（包、服务、事件、工具、命令、slot、patch 行、config key），再做文本匹配。面板行悬停显示命中数量；`upkeep_status` 工具的 `report.get` 返回命中的条目及其 Change / Migration 原文与触发命中的表面。

## 一键升级（M3 已交付；PR 交付在 M4）

在需要维护或存在命中破坏性变更的插件行上点 **升级** 并确认，选择是否在独立的 git worktree 中修改；Upkeep 会匹配指南、准备工作区、注册 Workspace，并用一段有边界的提示词打开新会话（点名具体的 Change/Migration 与验证命令）。agent 修改时你可以旁观、干预、打断；回到面板点 **验证**，它会在该工作区逐条运行命令并回报结果。

1. **匹配** —— 扫描插件的 manifest、bundle patch、import、服务、事件、工具、slot 与持久化数据，从迁移指南里挑出真正提到这些面的条目。
2. **计划** —— 把命中的 `Change` / `Migration` 原文作为有边界的任务交给编码 agent，附带涉及文件、验收命令与停止条件。
3. **修改** —— agent 在以你的仓库为根的独立 DSH 会话里工作；需要隔离时，在全新的 git worktree 里工作。你可以旁观、干预、随时打断。
4. **验证** —— 分层检查：manifest 重新判定、仓库自带的 check/test 命令、临时 profile 的准入检查，必要时再加一次临时 profile 的 headless 启动。
5. **交付** —— 你 review diff 与验证报告后，Upkeep 打开 PR（默认）或执行合并，全部由你确认。不会无人值守地推送或合并。

## 交付（M4）

验证通过后，通知里会出现 **创建 PR**：Upkeep 提交工作区、推送分支，并用宿主的 `gh` 创建 PR；面板显示 URL。开启 `allowMerge` 后会出现 **合并** 按钮——每一步都有自己的确认。失败的步骤会把错误记录在 run 上，不会假装成功。

## 定时巡检（M5）

**定时检查** 会创建周期性的 DSH 任务（默认每 24 小时，可配置）。每次投递会打开一个会话，用提示词刷新目标版本、执行检查，并汇报哪些属于你的插件需要维护、命中了哪些迁移条目。任务本身不修改仓库：升级仍在面板的 Upgrade / 验证 / 创建 PR 按钮之后。可在 DSH 的 Automation tasks 页面管理或暂停。

## 配置

Loader 行接受以下配置（括号内为默认值）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `targetChannel` | `auto` | 监测比较的 DSH 发布通道；`auto` 跟随桌面版的更新通道。 |
| `checkOnStartup` | `true` | Host 启动时是否执行一次兼容性检查。 |
| `concurrency` | `2` | 一次检查里并发处理多少个被监测插件（限制在 1–8）。 |
| `worktreeRoot` | `""` | 升级 worktree 的创建目录；留空表示放在仓库旁边的同级目录。 |
| `defaultBaseBranch` | `main` | preview 比较与 PR 目标分支。 |
| `allowMerge` | `false` | 是否提供「合并」；每次合并仍需单独确认。 |
| `scheduleCwd` | `""` | 定时检查创建的会话所用项目目录；留空用 `$DSH_HOME`。 |
| `scheduleIntervalHours` | `24` | 创建任务的默认间隔（1–720 小时）。 |
| `ownerHandles` | `""` | 标识你本人的账号 handle（npm scope / GitHub 登录名），逗号分隔；留空表示自动探测。 |
| `ownerEmails` | `""` | 标识你本人的作者邮箱，逗号分隔，与插件 `author` 匹配。 |
| `autoDetectOwner` | `true` | 是否允许用 `~/.gitconfig` 的 name/email 与已登录的 `gh` 账号作为身份。 |

## 开发

```sh
npm install
npm run verify   # 两端类型检查、构建、运行单测、客户端脚本语法检查
```

| 命令 | 作用 |
|---|---|
| `npm run build` | 把 Host 半与客户端脚本编译到 `dist/`。 |
| `npm run check` | 只做类型检查，不产出文件。 |
| `npm test` | 构建、编译测试、对 `dist/` 运行，最后 `node --check dist/client.js`。 |
| `npm run verify` | `check` + `test`。 |

装进运行中的 profile 之前先重新构建：link 安装直接服务 `dist/`。架构与里程碑在 `docs/PLAN.md`，经过核实的 DSH 事实在 `docs/EVIDENCE.md`，面向贡献者与 agent 的工程契约在 `AGENTS.md`。

## 全量测试

`npm run verify:full` 会跑完整一遍：单测与契约测试、包元数据、CLI 组合出的 desktop profile（确认本 bundle 的 row 进入 Loader），以及一次真实的 npm registry 目标版本读取。环境不支持的步骤会标记为 `skipped`，不会静默通过。

## 注意事项

- **M0 是只读的。** 它读取版本、profile 状态与 bundle 状态；不安装、不改文件、不发网络请求。
- **兼容性判定尚未实现。** Upkeep 面板目前展示的是 DSH 已记录的加载错误；声明层/运行层/前瞻层判定随 M1 一起到来。
- **客户端半是独立加载的。** 改完 `src/client.ts` 要刷新页面；改完 Host 代码要重启 Harness，让模块代际被替换。
- **link 安装服务 `dist/`。** 安装或重新加载前先 `npm run build`，否则新代码不会出现。
- **归属是推断，不是账号系统。** 它读取包元数据与本地 checkout 的 git remote；这些信息认不出你时，插件保持 **未知**，可以用 `ownerHandles` 显式指定。整个过程不会联网校验作者身份。
- **「立即检查」** 从 npm registry 刷新目标 DSH 版本，对运行版与目标版分别重新判定，并把一次报告写进 `$DSH_HOME/upkeep/state.json`；面板显示目标版本与通道，缓存过期会标记 stale，只有点按钮时才联网。
- **Host 不会主动推送。** DSH 没有 Host→浏览器的推送通道；面板在打开时和点击时读取。这是有意设计，不是刷新坏了。
- **版本支持。** 在 DSH `0.2.2-rc.3` 上验证；声明范围 `>=0.2.2-rc.1 <0.3.0`。DSH 正处于 rc 迭代期，这个范围是对本插件所用接口面的承诺，不是对每个构建的保证。

## 喜欢它？

如果 `dsh-upkeep` 帮你省掉了发布当天的手忙脚乱，欢迎在 [GitHub](https://github.com/sleep9ull/dsh-upkeep) 点个 ⭐，也欢迎 issue / PR。

## 许可证

[MIT](LICENSE)
