# BrainX OpenClaw Plugin

该原生插件仅向 OpenClaw 暴露受控的 BrainX 猎头决策与业务闭环工具。它从 OpenClaw 运行时读取可信飞书身份，生成 60 秒主体声明，并且只访问本机 `127.0.0.1:3102/internal/v1/agent/tools/<tool>` Agent Gateway。

运行时必须通过服务环境提供 `BRAINX_AGENT_GATEWAY_TOKEN` 和 `BRAINX_AGENT_ASSERTION_SECRET`。不要把密钥写入 `openclaw.json`、插件目录或 Git。

插件不提供 Shell、SQL、文件、浏览器、同步或业务写入能力。顾问使用飞书即可，无需在个人电脑安装本插件。

生产安装器还会同步七个已审核顾问 Skill：今日安排、职位判断、人才事实、人才匹配、沟通草稿、面试准备和个人复盘。Skill 决定 Agent 如何组织工作，原生插件负责受控取数；二者缺一不可。

## 飞书功能首页

已授权顾问在私聊输入 `/brainx` 会直接打开不调用模型的功能卡片。卡片提供今日优先事项、职位推荐、候选人匹配、职位判断、跟进建议和个人复盘六个入口。按钮只发起问答，不直接写业务状态。如果 `BRAINX_BASE_URL` 是 HTTPS，卡片还会显示正式工作台入口。

完整边界和验收流程见 [BrainTex 飞书功能首页](../../docs/2026-09-03-braintex-feishu-home.md)。
