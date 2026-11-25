# dsh-tokenplan-quota

DeepSeek Harness (DSH) 插件：实时查看千问 Token Plan 个人版额度。
A DSH plugin for live Qianwen Token Plan (Individual) quota visibility.

## 功能 / Features

- **侧栏卡片**：剩余/总额度、月进度条、今日使用、qwen3.8-flash 夜间折扣（22:00–08:00）倒计时进度条。
- **设置 → 插件 → Token Plan 额度 面板**：档位、重置时间、订阅到期、数据来源徽章、刷新/轮询设置、分模型 token 台账与折算价格（¥）。
- **Agent 工具** `tokenplan_quota_status`：让模型只读查询额度快照。
- 三级数据源，按可信度自动降级并在 UI 诚实标注：
  - **A · 官方 qianwen CLI**（真实数据）：`qianwen subscription tokenplan status`。需已 `npm i -g @qianwenai/qianwen-cli` 并 `qianwen auth login`。
  - **B · 本地会话日志估算**：从本机 DSH 会话记录统计 token 并按费率折算（≈，费率锚定未经官方核实，仅覆盖本机调用）。
  - **C · 网关探测**：可选，用本机环境变量中的 sk-sp Key 做一次性只读 GET（默认几乎不可用，仅前向兼容）。
- 「今日使用」= 月累计剩余额度相对今日起点的差值（CLI 无个人版日粒度数据时的本地基线；宿主重启会重设基线）。

## 隐私 / Privacy

- 不上传任何数据；查询全部发生在本机（宿主进程 spawn 官方 CLI / 读本地会话日志）。
- sk-sp Key 只从本机环境变量（`QWEN_TOKEN_PLAN_CN_API_KEY` → `TOKENPLAN_QUOTA_API_KEY`）解析，永不回显、永不写日志。
- 绝不自发模型调用刷额度。

## 安装 / Install

```bash
dsh plugin add dsh-tokenplan-quota
```

或在 dshmarket / DSH 内置 Discover 中搜索安装；本地目录安装：设置 → 插件 → Add plugin → 指向本仓库。
需 DSH ≥ 0.2.0；Windows/macOS/Linux 均可（CLI 调用已兼容 npm `.cmd` shim，不会崩宿主）。

## 配置 / Config

`pollIntervalSec`（轮询秒数，默认 120）、`cliTimeoutSec`、`apiKeyRef`（存环境变量名，非密钥本身）。

## License

MIT
