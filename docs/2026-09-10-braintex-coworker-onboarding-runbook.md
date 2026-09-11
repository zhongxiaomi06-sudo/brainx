# BrainTex 同事开通与首次使用实用手册

> 上级入口：[文档书总目录](README.md) · [服务器部署手册](2026-09-03-braintex-server-deployment-agent-manual.md) · [OpenClaw 多顾问运行手册](2026-09-03-openclaw-production-runbook.md) · [飞书权限清单](2026-09-02-feishu-permission-scopes.md)

## 1. 这份手册解决什么

目标是让一位已获得业务批准的同事，只用飞书和 HTTPS 工作台就能使用 BrainTex，不在本人电脑安装 OpenClaw，不要求本人提供 API Key。公司 StepFun 默认模型由服务器统一保管；个人模型只是可选覆盖。

这份手册是给“有权读取本仓库、并能按需登录部署服务器的开发/部署 Agent”执行的，不是给飞书里的 BrainTex 聊天 Agent 自行提权的。BrainTex 聊天 Agent 没有、也不应有修改自身白名单、身份绑定或飞书权限的能力。

## 2. 直接发给部署 Agent 的任务文案

将下面这段话发给同事的 Codex/部署 Agent，只替换尖括号内容：

```text
请按仓库 docs/2026-09-10-braintex-coworker-onboarding-runbook.md，为 <consultant_id> 在飞书 account=mia 下完成 BrainTex 开通。
先只读运行服务器预检、onboarding-plan 和 readiness，逐层报告缺项；不得从昵称猜 open_id，不得输出环境文件、token、App Secret 或 TTC 凭证。
飞书应用可用范围与新版本发布、本人身份映射、TTC/OpenMai 业务授权必须由对应负责人确认；未获批准时停在该步，不自动放大权限。
获得明确批准后，只执行本手册的精确绑定和授权命令，再用该同事真实飞书账号完成 /brainx、开工自检、私聊问答、项目群 @、工作台 OAuth 和一次授权职位读取。
最后按手册的证据模板回报，没有真机证据的项目不得写“已完成”。
```

## 3. 开通前必须明确的信息

| 信息 | 权威来源 | 禁止做法 |
|---|---|---|
| `consultant_id` 与在职状态 | BrainX 已核验花名册 | 从飞书昵称自动猜测 |
| 当前 BrainTex App 下的用户身份 | 飞书事件或管理员核验 | 复用另一个 App 的 open_id |
| 飞书应用可用范围 | 飞书管理后台 | 只把机器人拉进群就当作开通 |
| TTC/OpenMai 使用授权 | TTC 凭证所有者/业务负责人 | 复制 Mia 的 JWT 到其他人槽位 |
| 项目和人才范围 | 职位成员关系与人才授权账本 | 用“同在一个群”代替业务授权 |

## 4. Agent 执行顺序

### 4.1 先只读检查

Agent 先按 `AGENTS.md` 取得工作锁并确认工作区，然后在服务器 `/opt/brainx` 中执行：

```bash
deploy/openclaw/install.sh --validate
```

在只向当前 shell 加载 `/etc/brainx/agent.env` 和 `/etc/brainx/openclaw.env` 后，执行：

```bash
node bin/brainx-agent-admin.mjs onboarding-plan --account mia --consultant <consultant_id>
node bin/brainx-agent-admin.mjs readiness --account mia
```

不得使用 `cat`、`env`、`printenv` 或 `set -x` 输出环境文件。`onboarding-plan` 只返回脱敏布尔状态、阻塞项、负责角色和下一步。

### 4.2 飞书管理员必须完成的操作

1. 确认新同事在应用可用范围内。
2. 核对应用身份最小权限：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:chat`、`contact:user.base:readonly`、`im:resource`。
3. 若开放 Offer 报告，再核对 Docx v1 创建和编辑权限。
4. 确认长连接和 `im.message.receive_v1` 事件。
5. 进入“版本管理与发布”，创建新版本并确认发布。

前四项只在后台勾选而第五项没做，等于没生效。Agent 可以提供差异清单，不能代替租户管理员审批。

### 4.3 服务器绑定

部署 Agent 将管理员已核验的用户加入 `BRAINX_FEISHU_ALLOWED_OPEN_ID_n` 槽位。不要把 open_id 写进仓库、文档或聊天记录。若所有槽位都已使用，应扩充受控模板后再部署，不得覆盖现有员工。

已确认花名册与飞书当前 App 身份后：

```bash
node bin/brainx-agent-admin.mjs bind-roster \
  --tenant <TENANT_ID> \
  --account mia \
  --consultants <consultant_id> \
  --confirm true
```

若花名册缺失或 App 换过，停止执行；先由人核验身份，再使用完整部署手册中的 `bind-identity`，不从用户输入中推断。

### 4.4 TTC/OpenMai 授权

只有凭证所有者与业务负责人明确批准后，才能执行：

```bash
node bin/brainx-agent-admin.mjs grant-ttc-openmai \
  --source <approved_source_consultant_id> \
  --grantee <consultant_id> \
  --reason "<已核验的业务授权原因>" \
  --confirm true
```

该命令只建立用途受限的授权记录，不复制、输出或回显 JWT。未批准时，同事仍可使用机器人和已授权职位，但 OpenMai 必须显示为未就绪。

### 4.5 应用配置变化后刷新运行态

只有白名单、插件或工具策略发生变化时，才按部署手册执行安装器 `--apply` 和完整重启。不得只依赖热加载；不得通过关闭 allowlist 解决单人问题。

### 4.6 最终就绪检查

重新执行：

```bash
node bin/brainx-agent-admin.mjs onboarding-plan --account mia --consultant <consultant_id>
node bin/brainx-agent-admin.mjs readiness --account mia
```

`ready_for_bot=true` 只证明机器人与 BrainX 身份链就绪；`ready_for_search=true` 才证明 TTC/OpenMai 也就绪。这两项都不代替飞书后台发布状态和真机验收。

## 5. 新同事在飞书里怎么开始

1. 打开 BrainTex 机器人私聊，发送 `/brainx`。
2. 点击“检查我的开工状态”；不要在聊天中发 API Key 或 TTC 凭证。
3. 状态全部就绪后，点击“推荐值得做的职位”，或直接说“今天最值得做的 5 个职位是什么”。
4. 选中职位后，说“我要接手这个职位”；核对职位和下一步后明确确认。
5. 进入项目群后，必须 `@BrainTex` 才触发回复。根据职位画像选择 OpenMai 或 SuperMai；找人会产生任务或费用，会先等用户确认。
6. 需要工作台时点击 HTTPS 按钮；首次进入按飞书 OAuth 登录，不在 URL 中传身份或 token。

## 6. 必做的真机验收

新同事本人使用自己的飞书账号，顺序完成：

- [ ] 私聊 `/brainx` 返回功能首页。
- [ ] “检查我的开工状态”返回本人状态，不包含他人数据。
- [ ] 普通问答使用公司默认模型，不要求本人填 API Key。
- [ ] 职位推荐只包含本人或项目授权范围。
- [ ] 白名单项目群中，不 @ 不回复，@ 后正常回复。
- [ ] 工作台链接先 OAuth，有权对象可见，无权对象拒绝。
- [ ] 找人自检为就绪；如果需要发起真实搜索，另行获得用户对职位、条件和费用的确认。
- [ ] 另一位顾问请求仅授权给本人的职位时失败关闭，不泄露对象是否存在。

仅看到机器人、仅有服务 `active`、仅有插件 `loaded` 或仅有 `ready_for_bot=true`，都不能替代上述验收。

## 7. Agent 最终回报模板

```text
对象：<consultant_id>
服务器版本：<commit>
预检：通过 / 未通过（原因）
飞书可用范围与版本发布：已由 <负责人> 确认 / 待确认
花名册身份：就绪 / 未就绪
OpenClaw 白名单：就绪 / 未就绪
Gateway 身份：就绪 / 未就绪
TTC/OpenMai：就绪 / 未授权 / 凭证失效
真机验收：<通过数>/7
未完成项：<逐项列出负责人和下一步>
结论：可使用对话 / 可查授权职位 / 可找人 / 尚不可对外声称已开通
```

## 8. 故障快速定位

| 现象 | 先查 | 不要做 |
|---|---|---|
| 搜不到机器人 | 应用可用范围、版本发布 | 新建第二个同名机器人 |
| `/brainx` 提示未授权 | OpenClaw 白名单 | 让用户在群里粘贴 open_id |
| 能看首页但职位无权 | Gateway 绑定、项目成员关系 | 复制 Mia 的业务授权 |
| 可对话但不能找人 | TTC/OpenMai 用途授权和凭证时效 | 让同事把 JWT 发到聊天 |
| 私聊正常、群里无响应 | 群白名单、sender、BrainX 群 scope、是否 @ | 关闭群限制 |
| 建群失败 | `im:chat`、App 是否同源、版本是否发布 | 混用两个 App 的 open_id |

## 相关文档

- [BrainTex 飞书功能首页与新用户指引](2026-09-03-braintex-feishu-home.md)
- [顾问个人模型配置规格](../specs/004-personal-model-config/spec.md)
- [安全操作手册](SECURITY.md)
- [上传前完整验证](standards/PRE_PUSH_VERIFICATION.md)
