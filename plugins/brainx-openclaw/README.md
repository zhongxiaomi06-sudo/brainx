# BrainX OpenClaw Plugin

该原生插件仅向 OpenClaw 暴露十个 BrainX 猎头决策工具。它从 OpenClaw 运行时读取可信飞书身份，生成 60 秒主体声明，并且只访问本机 `127.0.0.1:3102` Agent Gateway。

运行时必须通过服务环境提供 `BRAINX_AGENT_GATEWAY_TOKEN` 和 `BRAINX_AGENT_ASSERTION_SECRET`。不要把密钥写入 `openclaw.json`、插件目录或 Git。

插件不提供 Shell、SQL、文件、浏览器、同步或业务写入能力。顾问使用飞书即可，无需在个人电脑安装本插件。
