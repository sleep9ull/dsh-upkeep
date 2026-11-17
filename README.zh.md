# dsh-upkeep

[English](README.md) · **简体中文**

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-4b8bbe)
![License](https://img.shields.io/badge/license-MIT-green)

> **状态：`0.1.0`，早期版本。** 包名是 **`@sleep9ull/dsh-upkeep`**：
> `dsh plugin --profile <name> add @sleep9ull/dsh-upkeep`。
> 已在 **macOS 上的 DSH `0.2.2-rc.3`** 验证，支持中英文。监测、升级准备、定时检查与面板
> 这几条路径已经真机走过；**创建 PR 那一步实现了也有单测，但还没有在真实 GitHub 仓库上跑过**，
> 建议先拿一个测试仓库试。

**为 [DeepSeek Harness](https://www.deepseek.com/harness/) 插件作者准备的兼容性管家。**

> DSH 迭代很快。一个插件不再声明兼容当前版本时，它不是"有点小问题"——DSH 会直接拒绝加载它，对应的行被静默禁用，唯一的痕迹是 stderr 上的一行日志。搞清楚**为什么**、再修好它，每个版本都要手工来一遍。
>
> `dsh-upkeep` 把这条链路闭合：持续监测你维护的插件，在你的用户之前告诉你哪里坏了，并把一次不兼容变成定向升级、验证，以及一个由你确认的 PR。

`dsh-upkeep` 是一个面向插件作者的 DSH 插件。它知道已安装的插件里哪些是**你的**、它们在你今天运行的 DSH 和即将升级到的 DSH 上还能不能工作，以及坏掉时到底该改什么。

## 主要功能

- **兼容性监测** —— 同时掌握运行中的 DSH 与下一个 DSH（从 npm registry 读取，按发布通道判定），对你的每个插件分别判定。会破坏你插件的版本，在安装之前就看得见，而不是装完才发现。
- **迁移报告** —— 读取 DSH 自带的升级指南，扫描每个插件实际用到的接口（包、服务、事件、工具、命令、slot、patch 行、config key），只列出真正提到这些面的破坏性变更，并附上 `Change` / `Migration` 原文与命中依据。
- **一键定向升级** —— 用命中的变更生成有边界的任务，可选在全新的 git worktree 中执行，并用这段提示词打开一个会话。agent 修改时你可以旁观、干预、打断；之后「验证」会在该工作区跑插件自己的 check/test 并逐条回报。
- **人工确认的交付** —— 只有在你明确确认后才提交、推送、创建 PR（开启后才允许合并），每一步的失败都会被记录而不是隐藏。默认只创建 PR，合并是显式开关。
- **定时巡检** —— 通过 DSH 的定时任务，周期性地刷新目标版本、执行检查并汇报需要维护的插件；它不会自行修改仓库。
- **归属靠证据，不靠猜** —— 「我的 / 他人 / 未知」由包 scope、author、repository、本地 checkout 与 git remote 与**本机身份**（配置、`~/.gitconfig`、已登录的 `gh` 账号）匹配得出；官方 `@deepseek-ai/*` 包被排除并计数，不会混进清单。

面板能做的，agent 通过 `upkeep_status` 工具也能做；每条结论都能追溯到证据：一份 manifest、一个实时行状态，或一条迁移指南。

## 安装 / 更新

把发布版装进运行界面的那个 profile（npm 安装在 `web`，桌面应用在 `desktop`）：

```sh
dsh plugin --profile desktop add @sleep9ull/dsh-upkeep
```

`0.1.0` 上架之前，请用下面的本地 checkout 方式安装：

```sh
git clone https://github.com/sleep9ull/dsh-upkeep.git
cd dsh-upkeep
npm install
npm run build
```

然后在 DSH 网页版或桌面版打开 **设置 → Plugins → Add plugin**，选择该目录并安装。bundle 以 link 方式安装，直接服务构建产物 `dist/`——改完 Host 代码需要重新构建并重启 Host，改完客户端代码刷新页面即可。

使用 `dsh` CLI：

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-upkeep
```

`<profile>` 用你运行 Web UI 的那个（npm 安装用 `web`，桌面版用 `desktop`）。更新时拉取代码后执行 `npm install && npm run build` 并重新加载。

## 使用方法

| 入口 | 作用 |
|---|---|
| **Upkeep 面板** | 左侧面板列表里固定的图标，与 **Plugins**、**Automation tasks** 同级。顶部一句话回答维护结论，下面是每个被监测插件的台账：版本、一列状态（正常 / 需维护 / 未知；他人插件显示实时启停状态），以及（仅你自己的插件）一列「定时」（显示是否已有周期性检查、或提供「创建」按钮）和一列「操作」（放 **升级** 按钮，状态列不再挤按钮）。实时启停、条目数、安装来源与兼容性需求都在行悬停里。有插件需要维护时，侧边栏名称后会带上括号计数——`Upkeep (2 个需维护)`；全部正常时只显示 `Upkeep`。 |
| **设置 → Plugins → Upkeep** | 从插件管理页面进入同一视图，并可跳转到完整面板。 |
| **`upkeep_status` 工具** | 模型看到的同一份快照，另有 `check`、`bundles.list`、`report.get` 取命中的迁移条目。 |
| **Refresh（刷新）** | 唯一的按钮：重读插件、对运行版与目标版判定、重新匹配迁移指南，并写入一条报告。缓存未超过 `feedTtlMinutes` 的目标版本会被复用，所以点击不一定触发 registry 请求；需要强制取新时，agent 工具可传 `force`。 |
| **升级** | 只在需要维护的插件行上出现（即使迁移报告有命中，Healthy 行也不显示）：在弹出的对话框里确认并选择是否使用 worktree，然后带着准备好的提示词打开会话。 |
| **验证 / 创建 PR / 合并** | agent 改完后：运行验证命令，然后创建 PR；仅在开启时才能合并。 |
| **定时**（按行） | 没有定时任务的行显示 **创建** 按钮，点击后弹出一个小对话框，内含时间选择器（默认本机 08:00，可调整，并连同你的 IANA 时区一起保存），确认后为这**一个**插件创建每日检查；创建后该单元格改为「时间 + 频率」的表达（如 `每天 8:00am`、`每 6 小时 9:30am`），悬停可看任务名与下次触发时间。一次只创建一个插件。 |

## 兼容性如何判定

DSH 只有一个官方判据，Upkeep 照抄它而不是另发明一套：

1. **声明层** —— 插件自己的 `engines.dsh` 范围单独决定；没有它时，每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都必须满足。预发布版本参与比较，`workspace:^|~|*` 表示当前运行版本。不满足时，只有 profile 的 `compatibility.json` 中针对精确版本的豁免才算数。
2. **运行层** —— 插件行的实时 fiber 阶段，用于抓"范围满足但 import 或启动失败"的插件。
3. **前瞻层** —— 对下一个 DSH 做同样的声明层判定。这正是 DSH 自己在升级前做不到的部分。

读不到 manifest、服务未挂载等情况会显示为**未知 + 原因**，绝不显示成兼容。目标版本来自 npm registry：桌面通道映射到 dist-tag，并以上述最大 semver 作为回退；滞后的 `latest` 标签不会被单独信任，缓存结果会标记 stale。

## 迁移报告

一次检查会读取运行版与目标版之间 DSH 自带的升级指南；目标比安装版新时，从对应的 release tag 拉取缺失的指南。随后扫描每个插件真正用到的接口，并在**标识符边界**上匹配指南文本，每个命中都带上包/服务/事件/工具/slot 依据。

面板在行悬停里显示命中数量；`report.get` 返回命中的条目及其 `Change` / `Migration` 原文。机械匹配没有结果时，Upkeep 会直说，而不是假装插件没问题。

## 升级与交付

**升级** 会准备工区（当前 checkout，或按需创建的 `git worktree`）并启动会话，提示词把范围限定死：**只改 DSH 版本变化逼出来的地方**，其他东西一律不动。agent 负责修改，你始终掌握控制权。准备结果的通知里也会列出 Host 的提醒——仓库有未提交改动、worktree 从 HEAD 开始，或指南拉取降级等。

**验证** 会在该工作区运行配置的命令（默认取包里的 `check` 与 `test` 脚本，没有则 `build`），逐条记录退出码。**创建 PR** 会提交、推送并用 `gh` 创建 PR；**合并** 只在开启 `allowMerge` 时出现，且每次都要再次确认。失败的步骤会把错误记在 run 上——没有静默成功。

## 定时巡检

每个插件可以单独被检查：在它的「定时」单元格点 **创建**，就会通过 DSH 自带的定时任务服务创建一个只检查这个插件的周期任务（默认每 24 小时，可配 `scheduleIntervalHours`）。之后单元格显示「时间 + 频率」（如 `每天 8:00am`），悬停可看任务名与下次触发时间；在 Automation tasks 页面暂停任务后，「创建」按钮会重新出现。每次投递会打开一个会话，但保存的只是**启动器**：它只让 agent 调 `upkeep_status` 的 `check`，然后严格按返回里的 `brief` 执行。策略（汇报什么、怎么给发现的问题分级、哪些不许做）来自**当前安装的插件版本**，所以升级 dsh-upkeep 后，已有任务下次投递就会按新策略执行，不需要改动你的任务。如果你自己改写过任务里的提示词，Upkeep 不会覆盖它。旧启动器会在 Host 启动时以及每次检查开头被带到当前版本，所以即使从不打开面板，升级也会生效。任务不会修改仓库；升级仍然在面板按钮之后。可在 DSH 的 **Automation tasks** 页面管理或暂停。

## 配置

Loader 行接受以下配置（括号内为默认值）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `targetChannel` | `auto` | 比较的发布通道；`auto` 跟随桌面版更新通道。 |
| `targetVersion` | `""` | 精确目标版本；留空则询问 registry。 |
| `feedTtlMinutes` | `60` | registry 缓存的有效分钟数。 |
| `checkOnStartup` | `true` | Host 启动后是否自动检查一次。 |
| `checksToKeep` | `20` | 保留多少条检查报告。 |
| `analyzeOnCheck` | `true` | 检查时是否同时匹配迁移指南。 |
| `concurrency` | `2` | 一次检查并发处理多少插件（1–8）。 |
| `verifyCommands` | `[]` | 「验证」执行的命令，在工作区里用 `sh -c` 执行（等于拥有你的命令行权限）；留空从 package scripts 推导。 |
| `runsToKeep` | `10` | 保留多少条升级运行记录。 |
| `ignoreWorktrees` | `true` | 是否把 `.worktrees/` 写入本 clone 的 `.git/info/exclude`；关闭则完全不改你的仓库（面板会给出警告）。 |
| `worktreesToKeep` | `5` | 每个仓库保留多少个升级 worktree；超出时在新建前删除最旧的及其 `upkeep/*` 分支。`0` 表示全部保留。 |
| `worktreeRoot` | `""` | worktree 创建目录；留空则在仓库内的 `<repo>/.worktrees/upkeep/<run>`，并把该路径写入本 clone 的 `.git/info/exclude`。 |
| `defaultBaseBranch` | `main` | preview 比较与 PR 目标分支。 |
| `allowMerge` | `false` | 是否提供「合并」；每次合并仍需确认。 |
| `ownerHandles` | `""` | 标识你本人的账号 handle；留空自动探测。 |
| `ownerEmails` | `""` | 标识你本人的作者邮箱。 |
| `autoDetectOwner` | `true` | 是否用 `~/.gitconfig` 与 `gh` 登录作为身份。 |
| `scheduleCwd` | `""` | 定时检查会话的项目目录；留空用 `$DSH_HOME`。 |
| `scheduleIntervalHours` | `24` | 创建任务的默认间隔（1–720 小时）。 |

## 开发

```sh
npm install
npm run verify       # 仓库 checkout
npm run verify:pack  # npm 会发布的 tarball，装进一次性 profile 验证
npm run verify       # 两端类型检查、构建、全部测试，以及面板的无头渲染
npm run verify:full  # 以上全部 + 包元数据 + profile 检查 + 真实 registry 读取
```

架构与决策在 `docs/PLAN.md`，经过核实的 DSH 事实在 `docs/EVIDENCE.md`，工程契约在 `AGENTS.md`。状态保存在 `$DSH_HOME/upkeep/state.json`（版本化、原子写、有界；丢失只损失一次重新检查，不影响行为）。

## 它会碰你机器上的什么

Upkeep 读取已安装的插件，并在你要求时为你自己的某个仓库准备升级。它会访问 npm registry 与 GitHub 取元数据，写入 `$DSH_HOME/upkeep/state.json`，为隔离升级创建 `<repo>/.worktrees/upkeep/<run>`，并运行 `git`/`gh` 与你配置的验证命令。它不会改你的源码，也不会在你确认前提交或推送。完整清单与干净卸载步骤见 [docs/SECURITY.md](docs/SECURITY.md)；发布流程见 [docs/RELEASE.md](docs/RELEASE.md)。

Host 侧的警告也会跟随语言：面板每次请求都带上当前语言，所以中文界面看到的是中文警告，而不是英文。

## 注意事项

- **优先 macOS。** 在那上边开发与验证；Host 半是纯 Node，Linux 上应当表现一致，但 **Windows 不支持**（`verifyCommands` 经 `sh -c` 执行）。
- **DSH 内部接口会变。** 插件直接读 DSH 自己的服务（定时任务、工作区、插件），并把 `engines.dsh` 锁在验证过的版本上。DSH 升级时要走一遍 dogfooding：先 `npm run verify`，再走安装验收。
- **两种语言。** 面板与 Host 警告支持中英文，其它 DSH 语言回退英文。
- **只管你自己的插件。** 官方 `@deepseek-ai/*` 按设计排除；他人插件只做诊断，不会被升级。
- **升级本身是会话里的 agent 在改代码。** 提示词把范围限死为 DSH 兼容性改动并禁止顺手修别的，但"看住会话、在 Verify→Create PR 前读 diff"仍然是你的活。



- **只在 DSH `0.2.2-rc.3` 上验证过**，声明范围也如实写成 `>=0.2.2-rc.3 <0.3.0`。更早的 prerelease 不在声明内——它们没被测过，而本插件读取的内部接口在 prerelease 之间确实会变。
- **PR 路径需要宿主 `gh` CLI 已登录**；合并需要 `allowMerge` 与当次确认。不会无人值守地推送。
- **link 安装服务 `dist/`。** 安装或重新加载前先构建；Host 改动需重启 Harness，客户端改动只需刷新页面。
- **worktree 从 HEAD 开始。** 未提交的改动不会被复制；仓库脏时面板会提示。合并该 run 后会清理其 worktree 与分支。
- **`git clean -xdf` 会删掉 worktree。** 它们在 checkout 里的 `.worktrees/` 下，只是被 ignore，并不受保护。
- **构建工具应排除 `.worktrees`。** 不读 `.gitignore` 的监听器（某些 bundler、`tsc --watch`）会扫到嵌套的 checkout；请把它们加入排除列表。
- **远端指南拉取需要网络。** 没有网络时只用安装版指南，并报告失败，不会隐藏。
- **尚未发布到 npm。** 按上面的本地 checkout 方式安装。
- **Desktop 独占运行中的 profile。** 应用打开时 CLI 无法组合 `--profile desktop`；全量测试脚本会把这一步标记为 skipped，而不是静默通过。
- **没有后台推送。** DSH 不会向浏览器推送；面板在打开与点击时读取，定时检查以会话形式出现。

## 许可证

[MIT](LICENSE)
