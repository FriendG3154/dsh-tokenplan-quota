![Token Plan quota panel showing remaining credits, usage bar and reset time](preview.svg)

密钥口径（v0.1.1 起）：sk-sp 密钥仅通过环境变量在本机解析（`QWEN_TOKEN_PLAN_CN_API_KEY`，可选项 `apiKeyRef` 指定其它变量名），不再使用宿主凭据存储（credentials seam 已移除）。面板与日志不回显完整 key。真实额度数据来自官方 qianwen CLI；未安装/未登录时降级为本地用量估算并明确标注「估算」。
