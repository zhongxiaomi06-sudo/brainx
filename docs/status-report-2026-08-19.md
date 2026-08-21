# BrainX 状态汇总报告

> 生成时间：2026-08-19 17:40（GMT+8）
> 范围：当前代码任务 / 当前 bug / 当前问题 / 目标计划
> 数据来源：本地 git 核查 + 今日工作日志（`.workbuddy/memory/2026-08-19.md`）

---

## 0. 一句话现状

核心业务链（TTC 扫码 → 实时拉岗 → 接单自动找人 → SSE 回传 → 白屏已修）**已全部跑通并真人验证通过**；
最新出现一个**上游漂移**——GitHub 上 `jiands233` 刚提交 `3522f2a` 修复了"不感兴趣"反馈的 3 个前端 bug，本地与服务器都还没拿到；
**部署目标待定**（BrainX 应迁出共享机 47.110.93.137 到同账号新 ECS，你已暂停）。

---

## 1. 当前代码任务

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 1 | 本地运行架构跑通（server :3100 + vinext :4321 + nginx 反代） | ✅ 完成 | 真 RDS `ttc-rds-public-0707` 读写 |
| 2 | TTC JWT 自动同步（浏览器扩展扫码） | ✅ 完成 | 真人验证通过（York团队AI助手，有效至 2026/10/13） |
| 3 | TTC 实时拉岗入库（`bin/brainx-ttc-sync.mjs`） | ✅ 完成 | 实测 1000 岗 → 902 入库；跳过 98 个机密客户岗 |
| 4 | OpenMai 自然语言找人（`bin/brainx-openmai.mjs`） | ✅ 完成 | `--search/--ask/--job-id` 实测命中 |
| 5 | 接单自动触发找人（engagement ACCEPT → 异步 → SSE） | ✅ 完成 | `migrations/0015` + `src/openmai-task.js`，实测 9 位候选人 |
| 6 | 登录链路修复（飞书扫码入口 + `/login` 后端直出） | ✅ 完成 | OAuth 302 已通 |
| 7 | 职位详情白屏修复（`openmaiByJob` 跨作用域） | ✅ 完成 | `5009782`，Playwright 诊断清零 |
| 8 | 找人"职位不存在"修复（P-FIX 占位解析真身） | ✅ 完成 | `781a0f4`，接单 P-FIX→J 真身 |
| 9 | P-FIX 占位行数据治理 | ✅ 完成 | `493ca61`，970 → 3（有真身迁移、无源删除） |
| 10 | 移除 eazo 顶部横幅 | ✅ 完成 | `7cf2712`，dist 已重建、服务器线上已消失 |
| 11 | "不感兴趣"反馈（直隐 + toast 撤销 + 补充原因） | ⚠️ 本地落后 | 功能本地已完成，但 **3 个 bug 的修复在 `3522f2a`（GitHub），本地未拉** |
| 12 | 驾驶舱群消息 DRY_RUN 抓取（`scripts/session/`） | ⏸ 阻塞 | 等用户：跑 `login-capture.mjs` 扫码 + 给驾驶舱群 URL / `oc_` 群 id |
| 13 | TTC 岗位抓取阶段 2/3（company/pipeline 抓包 + 群名自动发现） | 📋 TODO | 链路已通，待扩展 |
| 14 | BrainX 独立部署到同账号新 ECS（两个 IP） | ⏸ 暂停 | 你已说"暂时不部署"，未建任何云资源 |

---

## 2. 当前 Bug 与缺陷

### 2.1 最新上游修复（**本地/服务器均缺失**，需拉取）
GitHub `main` = `3522f2a`（jiands233，17:30）修复"不感兴趣反馈间歇性失效"的 3 个 bug，改动 `frontend/btex-frontend/app/workbench.tsx`（+3/-2）：

1. **`notify()` 不 `clearTimeout`**：快速点两张卡片的 `×`，第二个 toast 被第一个的定时器提前关掉，看起来像"没反馈" → 用 `toastTimerRef` 统一管理定时器。
2. **input 态竞态**：点「补充原因」后旧 6 秒定时器还在跑，打字到一半 toast 被误关、输入丢失 → `askReason` 改走 `notify`（先 clear 旧 timer）。
3. **静默吞错**：撤销/补充原因失败也显示"已记录"，后端实际没写入 → 改为 `await` 真实结果，失败明确提示错误。

> 影响面：纯前端 toast/反馈交互，不影响后端数据；但会让用户以为"反馈成功了其实没写"。**建议尽快 fast-forward 拉到本地并重建 dist。**

### 2.2 长期存在的缺陷（standing）
- **16 个单测失败**：fixtures 行数 60→85 与断言脱节，沿用未修（低优先级，与核心链路无关）。
- **eazo 同步推回构建产物**：生产侧 eazo 机制会把 `dist/`/`.vinext/`/`.wrangler/` 强制 `git add -f` 推回仓库，与本地收敛反复冲突。**需在生产侧配 exclude**，否则每次同步都冲突。
- **P-FIX 纯 Bitable 源 3 个真身缺失占位行**：接单找人仍以"职位不存在"失败（数据治理边界，TTC 端可能已无该岗）。
- **launchd 本地常驻 `bootstrap` 报 I/O error(5)**：launchd gui/501 域会话隔离导致，非沙箱也失败。**需你在 GUI 会话手动恢复**（命令见日志）；手动 server 实例现占 3100。
- **无未提交本地源码改动**：工作树干净（仅 `.npmrc`、`src/sync.js.bak` 两个未跟踪文件，无害）。

---

## 3. 当前问题 / 风险

1. **Git 三端漂移（最关键）**
   - 本地 `main` = `493ca61`，GitHub `main` = `3522f2a` → **本地落后 1 个提交，且是干净 fast-forward**（`493ca61` 是 `3522f2a` 的直接父）。
   - 服务器 `/opt/brainx` 仍停在 `7cf2712` → **落后 GitHub 2 个提交**（`493ca61` + `3522f2a`），且这台机器本就要被新 ECS 替代。
2. **部署目标未定**：`47.110.93.137` 是同账号共享机（`/opt/reloop` 触达工作台 + `/opt/brainx` 都在跑），BrainX 不该长期驻留；你已决定迁到同账号新 ECS（两个 IP），但暂停未建。
3. **阿里云凭证安全**：你给的 AccessKey（尾号 `15v`）其实已配在既有 `ttc`/`ttc-rds` profile（cn-hangzhou），`brainx-ecs` 新 profile 因旗标名写错未落盘——**密钥未误存，安全**。将来部署直接用 `--profile ttc` 即可。
4. **eazo 同步缺陷**持续制造仓库噪声（见 2.2）。

---

## 4. 目标计划（Target Plan）

### 4.1 立即（低风险，建议今天做）
- **拉取上游修复**：`git fetch origin && git merge origin/main`（fast-forward 到 `3522f2a`），消除本地漂移。
- 重建前端 `npm run build` 让"不感兴趣" 3 个修复在本地生效。
- 顺手处理：未跟踪的 `.npmrc` / `src/sync.js.bak` 要么加 ignore 要么删（避免下次提交误带）。

### 4.2 部署（暂停中，待你确认规格后继续）
BrainX 迁到同账号新 ECS，形成"两个 IP"（新 BrainX 机器 + 现有 47.110.93.137 reloop）。步骤：
1. 你给新 ECS 规格/地域（建议沿用 `ttc` profile 的 cn-hangzhou，与 RDS 同区降延迟）。
2. 克隆/新建 ECS → 安全组放 `3100/80/443` → 装 Node 22。
3. 拉 GitHub `main`（`3522f2a`）→ `npm install` + `npm run build` → systemd 托管 `brainx.service`。
4. 绑定 EIP / 域名 → 验证 200 + eazo 横幅无引用。
5. 旧 `47.110.93.137` 上的 `/opt/brainx` 按你之前选择"用新机器替代"处置（撤销/保留/下掉待最终确认）。

### 4.3 后续功能（按优先级）
- 解除 DRY_RUN 阻塞：跑 `login-capture.mjs` 扫码 + 给驾驶舱群 URL/`oc_` 群 id → 抓真实 JSON（不入库）。
- TTC 岗位抓取阶段 2/3（company/pipeline 接口抓包、驾驶舱群名自动发现）。
- 修 16 个单测（fixtures 对齐）。
- 生产侧 eazo exclude 配置（根治构建产物回推）。
- P-FIX 3 个真身缺失行最终清理。

---

## 5. Git 三端状态速览

| 端 | HEAD | 备注 |
|----|------|------|
| Mac 本地 `main` | `493ca61` | 工作树干净；落后 GitHub 1 |
| GitHub `main` | `3522f2a` | 含"不感兴趣"3 bug 修复 |
| 服务器 `/opt/brainx` | `7cf2712` | 落后 GitHub 2；本要被新 ECS 替代 |

**线关系**：`7cf2712` → `493ca61` → `3522f2a`（线性，无分叉）。

---

## 6. 给你的下一步建议（等你拍板）

1. 要不要我现在 `git merge origin/main` 把 `3522f2a` 拉到本地并重建 dist？（fast-forward，零风险）
2. DRY_RUN 还做不做？做的话请提供驾驶舱群 URL + `oc_` 群 id，并准备在终端跑一次扫码。
3. 新 ECS 的规格/地域确定了吗？确定了我再走 4.2 部署流程（你说过暂时不部署，我默认不动云资源）。
