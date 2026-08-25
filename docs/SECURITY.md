# BrainX 安全操作手册

生产安全操作的三件事：**密钥备份**、**RDS 收紧**、**按人隔离激活**。按 checklist 执行，每项都有验证命令。

## 一、data/.secret 单点密钥：备份与恢复

### 密钥用途（为什么它这么重要）

| 用途 | 代码位置 | 丢失后果 |
|---|---|---|
| session HMAC（登录态签名） | `src/session.js` | 全员登录态失效，需重新登录 |
| 飞书令牌 AES-256-GCM 加密 | `src/feishu.js`（密钥 = sha256(.secret)） | 库里所有已存令牌不可解，**需全员重新 OAuth** |
| TTC JWT 托管加密 | `src/ttcsdk/auth.js`（复用 feishu.js 加解密） | 托管的 TTC 凭证不可解，需重新粘贴 |

一个文件管三把锁——**丢了它 = 全员重新授权**；**它与 data/brainx.db 一起外发 = 所有令牌等同明文**。

### 备份（每月一次或密钥变更时）

```bash
# 在生产机（阿里云 ECS Workbench 终端）执行：
cd /opt/brainx
# 1. 打包（同时含 .secret 与数据库结构，不含数据可去掉 db）
tar czf /tmp/brainx-secret-backup-$(date +%Y%m%d).tar.gz data/.secret
# 2. 校验包内容
tar tzf /tmp/brainx-secret-backup-*.tar.gz
# 3. 下载到本地加密存储（Workbench 网页终端有文件下载入口），或复制到对象 OSS 私有桶
# 4. 确认本地保存后清理临时文件
rm /tmp/brainx-secret-backup-*.tar.gz
```

本地保存纪律：加密盘/密码管理器附件，`chmod 400`，至少两处异地副本。

### 恢复（.secret 丢失/损坏时）

```bash
# 把备份的 .secret 放回原位（Workbench 上传或 scp）：
cd /opt/brainx
mv <上传的.secret> data/.secret
chmod 600 data/.secret
systemctl restart brainx
# 验证：登录页面不再报 session 校验失败；若令牌仍解不开 → 走下面「全员重新授权」
```

**无法恢复时的兜底**（.secret 彻底丢失）：删除 `data/.secret` 让系统重新生成 → 三名顾问各自重新 OAuth 飞书 + 凭证中心重粘 TTC JWT（见第三节）。此路径是设计内行为，不会丢业务数据（推荐/事件/事实都在库里，只有令牌需要重来）。

### 轮换（可选，低频）

轮换 = 生成新 .secret + 全员重新授权。只在怀疑泄露时做，日常不必。

## 二、阿里云 RDS 收紧 checklist

> 全部在阿里云控制台操作，改完每项勾掉。当前风险：超管直连 + 白名单全开 + 无 SSL + 明文密码落盘。

- [ ] **白名单收紧**：RDS 控制台 → 数据安全 → 白名单，删掉 `0.0.0.0/0`，只保留 ECS 的内网/公网 IP（ECS 控制台可查实例 IP）。
      验证：在 ECS 上 `node scripts/talent-health.mjs` 仍通；本机直连应被拒。
- [ ] **禁用超管日常使用**：hayden 只留 emergency，新建最小权限账号（仅 `brainx_talent` 库的 SELECT/INSERT/UPDATE/DELETE），`.env` 的 `BRAINX_MYSQL_USER` 换新账号。
- [ ] **开 SSL**：RDS 控制台开通 SSL（免费），`.env` 加 `BRAINX_MYSQL_SSL=1`（`src/db.js` 已预留该开关），重启后 `talent-health` 自检确认连接走 SSL。
      *内网白名单收紧后 SSL 优先级降低，可后做。*
- [ ] **密码不落明文**：`.env` 已在 .gitignore（确认 `git status` 不出现它即可）；ECS 上 `chmod 600 /opt/brainx/.env`。

## 三、按人隔离激活（0009 切换应用后的重新授权）

背景：0009 迁移切换飞书应用时清空了 `consultant_tokens`，之后无人重新登录——三人仍共用 Mia 的回退视野，按人隔离未真正生效。

### 激活步骤（每位顾问各自做一次，约 1 分钟）

1. 打开 `https://base.yorkteam.cn`，飞书扫码登录（OAuth，自动保存个人令牌）
2. 进「凭证中心」粘贴自己的 TTC JWT（个人视野的职位数据源；不粘则只看团队池数据）
3. 等下一轮同步（≤3 分钟），确认工作台出现自己名下的推荐

### 验证（管理员在 Workbench 执行）

```bash
cd /opt/brainx && node -e "
const {openDb}=require('./src/db.js');" 2>/dev/null || \
sqlite3 /opt/brainx/data/brainx.db \
  "SELECT consultant_id, length(encrypted_refresh_token)>0 AS has_token FROM consultant_tokens;"
# 目标：三名常用顾问（felix/mia/york）has_token 均为 1
```

### 常见问题

- 登录后页面提示「飞书授权待更新」：等一轮同步或重启服务（`systemctl restart brainx`）
- TTC 视野为空：凭证中心未粘 JWT，或 JWT 过期需重新获取

## 附：相关代码索引

| 主题 | 文件 |
|---|---|
| session HMAC | `src/session.js` |
| 令牌 AES 加解密 | `src/feishu.js` |
| TTC JWT 托管 | `src/ttcsdk/auth.js` |
| MySQL 连接与 SSL 开关 | `src/db.js`（`BRAINX_MYSQL_SSL`） |
| OAuth 回调存令牌 | `src/server.js`（saveUserTokens） |
| 按人同步回退逻辑 | `src/bridge.js`（无令牌 → skipped） |
