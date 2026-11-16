# dsh-upkeep

[English](README.md) · **简体中文**

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-4b8bbe)
![License](https://img.shields.io/badge/license-MIT-green)

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

`dsh-upkeep` 尚未发布到 npm registry，请从本地 checkout 安装：

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
| **Upkeep 面板** | 左侧面板列表里固定的图标，与 **Plugins**、**Automation tasks** 同级。顶部一句话回答维护结论，下面是每个被监测插件的台账：版本与一列状态（正常 / 需维护 / 未知；他人插件显示实时启停状态）。实时启停、条目数、安装来源与兼容性需求都在行悬停里。 |
| **设置 → Plugins → Upkeep** | 从插件管理页面进入同一视图，并可跳转到完整面板。 |
| **`upkeep_status` 工具** | 模型看到的同一份快照，另有 `check`、`bundles.list`、`report.get` 取命中的迁移条目。 |
| **立即检查** | 从 registry 刷新目标 DSH 版本，对运行版与目标版分别判定，扫描指南并写入一条报告。 |
| **升级** | 只在需要维护的插件行上出现（即使迁移报告有命中，Healthy 行也不显示）：确认、选择是否 worktree，然后带着准备好的提示词打开会话。 |
| **验证 / 创建 PR / 合并** | agent 改完后：运行验证命令，然后创建 PR；仅在开启时才能合并。 |
| **定时检查** | 通过 DSH 的定时任务服务创建周期性兼容性检查。 |

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

**升级** 会准备工区（当前 checkout，或按需创建的 `git worktree`）、注册 Workspace，并用一段点名了具体变更、文件与验证命令的提示词打开会话。agent 负责修改，你始终掌握控制权。准备结果的通知里也会列出 Host 的提醒——仓库有未提交改动、worktree 从 HEAD 开始，或指南拉取降级等。

**验证** 会在该工作区运行配置的命令（默认取包里的 `check` 与 `test` 脚本，没有则 `build`），逐条记录退出码。**创建 PR** 会提交、推送并用 `gh` 创建 PR；**合并** 只在开启 `allowMerge` 时出现，且每次都要再次确认。失败的步骤会把错误记在 run 上——没有静默成功。

## 定时巡检

**定时检查** 通过 DSH 自带的定时任务服务创建周期任务（默认每 24 小时）。每次投递会打开一个会话，刷新目标版本、执行检查，并汇报哪些属于你的插件需要维护、命中了哪些迁移条目。任务不会修改仓库；升级仍然在面板按钮之后。可在 DSH 的 **Automation tasks** 页面管理或暂停。

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
| `verifyCommands` | `[]` | 「验证」执行的命令；留空从 package scripts 推导。 |
| `runsToKeep` | `10` | 保留多少条升级运行记录。 |
| `worktreeRoot` | `""` | worktree 创建目录；留空放在仓库旁边。 |
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
npm run verify       # 两端类型检查、构建、单测、客户端脚本语法检查
npm run verify:full  # 以上全部 + 包元数据 + profile 检查 + 真实 registry 读取
```

架构与决策在 `docs/PLAN.md`，经过核实的 DSH 事实在 `docs/EVIDENCE.md`，工程契约在 `AGENTS.md`。状态保存在 `$DSH_HOME/upkeep/state.json`（版本化、原子写、有界；丢失只损失一次重新检查，不影响行为）。

## 注意事项

- **在 DSH `0.2.2-rc.3` 上验证**，声明范围 `>=0.2.2-rc.1 <0.3.0`。
- **PR 路径需要宿主 `gh` CLI 已登录**；合并需要 `allowMerge` 与当次确认。不会无人值守地推送。
- **link 安装服务 `dist/`。** 安装或重新加载前先构建；Host 改动需重启 Harness，客户端改动只需刷新页面。
- **worktree 从 HEAD 开始。** 未提交的改动不会被复制；仓库脏时面板会提示。
- **远端指南拉取需要网络。** 没有网络时只用安装版指南，并报告失败，不会隐藏。
- **尚未发布到 npm。** 按上面的本地 checkout 方式安装。
- **Desktop 独占运行中的 profile。** 应用打开时 CLI 无法组合 `--profile desktop`；全量测试脚本会把这一步标记为 skipped，而不是静默通过。
- **没有后台推送。** DSH 不会向浏览器推送；面板在打开与点击时读取，定时检查以会话形式出现。

## 许可证

[MIT](LICENSE)
