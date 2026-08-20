# 登录态抓取 / 复用（scripts/session）

用你**自己账号**登录一次飞书，把登录态加密存下来，后续脚本免登录复用去访问你**本就有权看到**的页面。

> 合法边界：仅用于你自己的账号、你有权访问的内容。不绕过风控、不抓他人凭证。

## 技术栈（对齐选型）
- **Playwright** `storageState` —— cookie + localStorage 一把存 / 一把复用
- **playwright-extra + stealth** —— 反自动化检测（扫码页更稳）
- **AES-256-GCM 加密** —— 登录态密文落盘，密钥走环境变量，堵仓库泄漏

## 一次性准备
```bash
# 1) 装依赖
npm i -D playwright playwright-extra puppeteer-extra-plugin-stealth
npx playwright install chromium

# 2) 生成加密密钥，写进 .env（.env 已被 .gitignore 忽略）
node -e "console.log('SESSION_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))" >> .env
```

## 使用

### 第一步：抓登录态（手动扫码一次）
```bash
node scripts/session/login-capture.mjs
# 浏览器打开飞书 → 你扫码登录 → 进主界面后回终端按 Enter
# 结果：加密登录态存到 scripts/session/.state.enc
```
可选：指定登录起始页 / 登录成功判定
```bash
LOGIN_URL="https://你的飞书应用页" READY_URL_HINT="/home" node scripts/session/login-capture.mjs
```

### 第二步：免登录复用，抓页面 / 接口
```bash
# 抓某页面的 HTML + 全页截图
node scripts/session/session-reuse.mjs "https://你有权访问的页面URL"

# 顺带抓该页调用的私有接口 JSON（把 /api/ 换成目标接口片段）
CAPTURE_API="/api/" node scripts/session/session-reuse.mjs "https://页面URL"

# 想看浏览器过程就关无头
HEADLESS=false node scripts/session/session-reuse.mjs "https://页面URL"
```
输出在 `scripts/session/out/`（HTML / PNG / api-*.json）。

### 第三步：抓驾驶舱群对话，直接入库到 job_messages
用你自己的登录态抓飞书驾驶舱群对话，复用 brainx 的 `ingestMessages`（幂等去重 + 职位归因 + 可见性 + 游标）：
```bash
# 先干跑看抓到什么（不入库）
DRY_RUN=true HEADLESS=false node scripts/session/capture-cockpit-chat.mjs "<驾驶舱群会话URL>" oc_群id felix

# 确认无误后正式入库
node scripts/session/capture-cockpit-chat.mjs "<驾驶舱群会话URL>" oc_群id felix
```
- 若抓不到消息：`HEADLESS=false` 打开，用 DevTools Network 看消息接口真实 URL 片段，用 `MSG_API_HINT="/该片段"` 指定。
- `SCROLL_ROUNDS` 控制向上加载多少轮历史（默认 6）。
- 抓到的消息会转成 brainx 消息契约后写入 `job_messages`，驾驶舱链路（`bridge.js` 的活跃度统计等）自动可用。

## 安全须知
- `.state.enc` 是**你的登录态密文**，`out/` 可能含**你账号可见的敏感数据**——两者都不进 git（见 .gitignore）。
- 密钥丢了就解不开，重跑 login-capture 即可。
- 登录态会过期；`session-reuse` 检测到要求重新登录会提醒你重跑抓取。
