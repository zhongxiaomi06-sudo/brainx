# braintex-mcp 安装包

把 TTC 决策系统（braintex）装成 Codex 的 MCP 插件：自然语言直接操作
今日推荐 / 承接状态 / 供给证据 / 结果反馈 / 调权。

## 安装（一条命令）

```bash
tar -xzf braintex-mcp-1.1.0.tar.gz && cd braintex-mcp-1.1.0 && ./install.sh
```

**有 TTC 账号（本机有 TTC 仓库检出）就是零密钥安装**：
- 安装器自动复用本机 TTC `.env` 的 RDS 连接信息（`~/Downloads/ttc*/.env` 等路径自动发现，
  也可用 `TTC_ENV=<路径>` 显式指定）；
- MCP 令牌（`TTC_DECISION_MCP_TOKEN`）是本机凭证——每台机器各自校验自己的 server 进程，
  安装时自动生成，不需要任何人发给你。

没有 TTC 检出的机器：安装器只会问一次 RDS 密码（向发包人索取）；令牌仍自动生成。

装完**重启 Codex** 即可。

## 装完能说什么

| 你说 | 插件调用 |
|---|---|
| 「看看我今天有什么推荐」 | `decision_today` |
| 「把 xx 岗位加入关注 / 这个我接了」 | `decision_command(watch/accept)` |
| 「这个岗位供给怎么样、有谁可推」 | `decision_evidence_supply`（Top3 含电话） |
| 「面试过了 / 反馈 4 分，记一下」 | `decision_record_outcome`（喂养自动调权） |
| 「看看我的承接列表 / 我的策略解锁没」 | `decision_engagements` / `decision_policy` |

agent 调用工具需要 `token` 参数：读 `~/.braintex-mcp/.env` 里的
`TTC_DECISION_MCP_TOKEN` 即可，不用问人。

## 高级选项

```bash
./install.sh --dir /opt/braintex-mcp   # 自定义安装目录（默认 ~/.braintex-mcp）
./install.sh --env-file my.env         # 非交互，直接复用现成 .env
./install.sh --also-claude             # 同时注册 Claude Code
./install.sh --also-opencode           # 同时注册 OpenCode
./install.sh --no-register             # 只装文件，不改 Codex 配置
```

## 安全说明

- 密钥只写在 `~/.braintex-mcp/.env`（chmod 600）；Codex 配置里**没有任何密钥**，
  只指向启动脚本。
- 每次调用（含只读）都要过令牌鉴权；服务未配置令牌会拒绝启动（fail-closed）。
- 卸载：`rm -rf ~/.braintex-mcp`，并删掉 `~/.codex/config.toml` 里
  `[mcp_servers.braintex]` 那 3 行。

## 环境要求

macOS / Linux，python 3.10+，能访问阿里云 RDS 公网端点（白名单 0.0.0.0/0）。
