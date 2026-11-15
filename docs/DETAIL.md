# Upkeep

Upkeep 是 DeepSeek Harness 的插件兼容性管家。它回答一个问题：**我写的这些 DSH 插件，还能不能在当前（以及即将到来的）DSH 上正常工作？**

## 它做什么

- 在 **Plugins → Upkeep** 标签页里显示运行中的 DSH 版本、当前 profile、已安装的 bundle 清单，以及每个 bundle 的版本与来源。
- 提供 `upkeep_status` 工具，让会话内的 agent 也能读取同一份状态（一个操作，两个调用方：面板与工具共用同一个 dispatcher）。

## 怎么用

1. 在 Plugins 设置页打开 **Upkeep**。
2. 点 **Refresh** 读取最新状态。
3. 需要 agent 参与时，在会话里让它调用 `upkeep_status`。

## 当前范围与限制

- 本版本只做**只读状态总览**，不做兼容判定、不改任何文件、不发起网络请求。
- 兼容性判定、迁移报告、一键升级、PR/合并与定时任务在后续里程碑实现（见仓库 `docs/PLAN.md`）。
- 面板数据来自 Host 半通过 `/api/upkeep/*` 提供的只读接口；没有开启客户端半时，工具仍可用。
