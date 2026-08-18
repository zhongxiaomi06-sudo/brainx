# braintex-mcp 交付说明（给同事 / 给同事的 agent）

> 你收到的物品：`braintex-mcp-1.3.0.tar.gz`
> sha256：`296467e4aff125890a5bd47ca5bf66684b11d63983c5d2ef08d1bd203683569b`（可用 `shasum -a 256 braintex-mcp-1.3.0.tar.gz` 自查）
>
> **有 TTC 账号（本机有 TTC 仓库检出）：零密钥交付，什么都不需要向发包人要。**
> 安装器自动复用本机 TTC `.env` 的数据库连接信息；MCP 令牌在你机器上自动生成。
> （没有 TTC 检出的机器，才会被问一次 RDS 密码——找发包人私聊要。）

装完后你的 Codex（可选 Claude Code / OpenCode）就能用自然语言直接操作
TTC 决策系统：今日推荐、承接状态、候选人供给（含电话）、结果反馈、调权。
**1.2.x 新增：「飞书连接」一键接入你自己的驾驶舱群（信号自动进共享库）+「上传简历」批量贡献你的存量简历。**
**1.3.0 新增：「客户 360」——客户档案自动归一（79 个客户已建档），每客户一页看全：岗位信号时间线、承接状态、结果反馈、每日动态摘要（确认/纠正会喂养你的个性化调权）。**

---

## 方式一：把下面这段话原样发给你的 agent（推荐）

```
帮我部署 braintex MCP 插件。安装包在 <压缩包所在路径>/braintex-mcp-1.3.0.tar.gz。
执行：
  cd <压缩包所在目录>
  tar -xzf braintex-mcp-1.3.0.tar.gz && cd braintex-mcp-1.3.0 && ./install.sh
它会自动复用本机 TTC 的 .env 并自动生成本机令牌，全程不需要你问我任何密钥。
装完用 python3 校验 ~/.codex/config.toml 里有 [mcp_servers.braintex]，
然后告诉我重启 Codex。
```

agent 全程非交互：装 venv → 装依赖 → 自动发现本机 TTC 环境 → 写 `.env`（chmod 600）
→ 自检（鉴权拦截 + 数据库读取，不过会装失败）→ 注册 Codex。

## 方式二：自己动手（终端两条命令）

```bash
cd <压缩包所在目录>
tar -xzf braintex-mcp-1.3.0.tar.gz && cd braintex-mcp-1.3.0 && ./install.sh
```

## 装完验证（可让 agent 做）

```bash
python3 -c "import tomllib; print(tomllib.load(open('$HOME/.codex/config.toml','rb'))['mcp_servers']['braintex'])"
```

能打印出 command 路径即注册成功。**重启 Codex** 后开始用。

## 接入你自己的驾驶舱（飞书连接，1.2.1 新增）

**一次授权，之后全自动**：你的驾驶舱群/职位市场/人才市场/交付群里的岗位信号
会持续采进共享库（指纹自动去重，全组数据汇一个池子，管理员可实时看到并调权）。

```bash
~/.braintex-mcp/bin/braintex-web.sh        # 起工作台
# 浏览器打开 http://127.0.0.1:8766/static/apps/brianx/feishu.html
# ① 首次使用：输入 App ID / App Secret 点「初始化」（找发包人私聊要，只输一次）
# ② 点「连接飞书」→ 浏览器打开飞书官方授权页点同意 → 自动开始首次同步
```

- 授权用的是**你自己的飞书账号**（设备流，官方页面操作，密码不过系统）；
  你只能采到你自己在的群，天然权限隔离。
- 前提：本机装有 lark-cli（没有就问发包人）。没装也能用全部决策功能。
- 工作台开着时，每 2 小时自动同步一轮；也可以随时点「立即同步」。
- 全组共享的岗位表信号（驾驶舱全景图、职位盘点等 307 条）已由发包方
  统一桥接，每日早 8:07 自动同步——这部分你装完就能查到，不用自己接。

## 上传你的存量简历（上传简历页）

工作台打开 `http://127.0.0.1:8766/static/apps/brianx/upload.html`，
拖入 pdf/docx/txt/md（一次最多 50 个）→ 自动提取姓名/手机号/邮箱 →
入共享人才库（950+ 份存量已在库）。指纹去重：同一份重复上传只更新；
已有富解析数据不会被你的上传覆盖（非破坏性合并）。全组同事立即可查可推。

## 客户 360（客户360页）

工作台打开 `http://127.0.0.1:8766/static/apps/brianx/client.html`：

- **客户列表**：系统把岗位信号里的公司名自动归一成客户档案
  （PixAI/Pix AI/沐仞科技这类变体自动合并；全部先标记「待审」）。
- **点进任一客户**：信号时间线 + 承接记录 + 反馈记录一页看全。
- **每日动态摘要**：点「生成今日摘要」——新增岗位/升温/关闭/降温一段话说清。
  看完点「确认」或「纠正」（纠正要写正确版本）——这条会进你的结果账本，
  直接影响你的个性化推荐调权。
- **人审归一**：确认归一 / 改名 / 合并，把「待审」客户转正。

## 日常使用（对 agent 说人话即可）

| 你说 | 实际调用 |
|---|---|
| 「看看我今天有什么推荐」 | decision_today |
| 「把 xx 岗位加入关注 / 这个我接了 / 暂不考虑（原因…）」 | decision_command |
| 「这个岗位供给怎么样、能推谁」 | decision_evidence_supply（Top3 含电话） |
| 「面试过了 / 反馈打 4 分，记一下」 | decision_record_outcome（喂养自动调权） |
| 「我的承接列表 / 我的调权解锁了没」 | decision_engagements / decision_policy |

**agent 调用工具需要 token 参数**：令牌是本机凭证，在
`~/.braintex-mcp/.env` 的 `TTC_DECISION_MCP_TOKEN`——agent 直接读这个文件即可，
不用问人。

## 可选参数

```bash
./install.sh --also-claude     # 同时注册 Claude Code
./install.sh --also-opencode   # 同时注册 OpenCode
./install.sh --dir /opt/xxx    # 换安装目录（默认 ~/.braintex-mcp）
```

## 常见问题

- **python 版本**：需要 3.10+（macOS 自带或 `brew install python@3.12`）。
- **PyPI 慢**：先 `export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple` 再装。
- **数据库连不上**：确认能访问公网；RDS 白名单是 0.0.0.0/0，仅需密码。
- **没有 TTC 检出**：安装器会停下来问一次 RDS 密码（找发包人私聊要）；
  令牌仍是本机自动生成。
- **密钥安全**：密钥只写在 `~/.braintex-mcp/.env`（chmod 600）；
  `~/.codex/config.toml` 里没有任何密钥。
- **卸载**：`rm -rf ~/.braintex-mcp`，再删掉 `~/.codex/config.toml`
  里 `[mcp_servers.braintex]` 那 3 行，重启 Codex。
