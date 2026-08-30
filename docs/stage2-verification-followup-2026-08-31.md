# BrainX 第二阶段部署验证补录（2026-08-31）

承接 [stage2-testing-guide-2026-08-30.md](stage2-testing-guide-2026-08-30.md)。本文档记录 2026-08-30 深夜至 08-31 凌晨对「三项部署」做完整性测试 + 前端点击实测的**新发现、修复与运维变更**。生产版本：`46e1575`（= #33 + #34 + #35）。

---

## 一、完整性测试新发现（3 个生产问题，全部已修复上线）

### F1（严重）worker 独立模式秒退崩溃循环 —— 批处理实际全停

- **现象**：`brainx-worker.service` 每 ~10s 重启一次，`NRestarts=50+`，每次打印完三行启动日志即 `exit 0`（"Deactivated successfully"）。bridge 同步 / 自动推荐 / 07:00/19:00 定时推送**全部空转**。
- **根因**：`6de4292` 为嵌入模式优雅停机给 bridge/scheduler 定时器加了 `unref()`——嵌入模式下正确（HTTP server 持有事件循环），但独立模式（`node src/worker.js`）事件循环没有任何 ref'd handle（node:sqlite 同步连接不持有循环），进程启动即干净退出，systemd `Restart=always` 无限拉起。最小复现：`node -e "const t=setTimeout(()=>{},60000); t.unref();"` → 立即 exit 0。
- **修复**：PR #33（`436b66d`）—— worker.js 主块加保活定时器（`setInterval(()=>{}, 1<<30)` 不 unref，SIGTERM/SIGINT 清除后退出）。回归测试 `tests/worker.test.mjs`：spawn 独立进程断言 2s 内存活 + SIGTERM exit 0（未修复代码上实测失败）。
- **验证**：部署后 `NRestarts=0`，持续 active；全量测试 259/259。
- **教训**："worker 被 kill → ~10s 自愈"的原验证结论具有欺骗性——崩溃循环的 worker 也会每 10s 被拉起。验证韧性要看**稳定存活时长**与 `NRestarts` 增量。

### F2 shadow-daily.timer enabled 但 inactive —— 08:00 日报不会触发

- unit 文件已 enable 但从未 start（`systemctl list-timers --all` 查无）。已 `systemctl start brainx-shadow-daily.timer` 修复，手动跑一次报告生成正常。
- **检查口径**：timer 必须看 `systemctl list-timers` 的 NEXT 列，`is-enabled` 不够。

### F3 前端硬编码吞掉后端 source_mode 透出 —— 驾驶舱筛选恒 0

- **现象**（驾驶舱 CSV 导入后暴露）：API Top20 含 12 条 COCKPIT_CONTEXT，页面「数据来源=驾驶舱」筛选显示 **0 条**。
- **根因**：`mapRecommendation`（brainx-api.ts）硬编码 `sourceMode: "MARKET_ONLY"`，后端 #31 起逐 item 透出的 `source_mode`/`membership_status` 在 UI 层被吞。
- **修复**：PR #34（`6d44ae4`）——按 `rec.source_mode` 映射，缺省 MARKET_ONLY（与后端判定一致）。质量门禁棘轮：brainx-api.ts 623 行基线净零增长。
- **验证**：浏览器实测驾驶舱筛选 12 条、UNCONFIRMED 透出；截图 `logs/brainx-cockpit-filter-e2e-20260831.jpeg`。

---

## 二、R1 根治：驾驶舱 CSV 已导入生产

`node bin/brainx-adapter.mjs --consultant felix`：82 市场 + 20 驾驶舱 → 102 职位（LLM on）。

- 隔离报告：`cockpit_context: 20 / market_only: 1299`（原 0/1218）
- 新信号（隔离规则忠实透出，正是会议要的"可区分"）：
  - `same_company_shadow: 34 对`——同一公司在市场源/驾驶舱源双建档（P-FIX vs J 前缀），待后续合并策略
  - `weak_ownership: 12`——CSV 中"待判断"行，membership_status=UNCONFIRMED（不升格）
- 手动触发新推荐轮（`POST /api/v1/recommendations/run`，run c6ab5d06）后队列 = 12 COCKPIT_CONTEXT + 8 MARKET_ONLY。

---

## 三、运维变更（2026-08-31 凌晨）

### 磁盘 89% → 72%：DB VACUUM 回收 ~3.2GB

- **根因**：brainx.db 3.1GB 中 98.3% 为 freelist 空闲页（8/24、8/25 两次 retention 删除后从未 VACUUM），活数据仅 ~53MB。
- 操作序列：retention `--apply`（删 7687 冻结行 + 3514 孤儿 run + 0 RECOMMENDED 事件）→ 停 brainx+worker → `VACUUM INTO` → `integrity_check=ok` + 表计数核对 → 换文件 → 起服。**3.1GB → 31MB**。
- 留档：旧库压缩 `data/brainx-old-3g.db.gz`（22MB）；删 8/24 过期备份（-311MB）；journal 收至 50M。
- **防复发**：`brainx-retention.timer` 已装（每周日 03:17，首跑 2026-09-06；只删行止增长，VACUUM 仍走手动离线窗）。unit 在 /etc/systemd/system/（brainx-retention.{service,timer}），尚未入仓。

### 服务器 npm install ENOTEMPTY 病

`npm install` 在 @next/* 等包上 rename 连环失败（与网络无关，npm reify 与该文件系统相性）。**绕过**：本地 `tar czf` 打包 `node_modules/<pkg>` → scp → 服务器解开（marked 即以此安装；零依赖包安全）。根治（清 npm cache / 升级 npm）留待维护窗。

### GitHub 断连时的代码同步：git bundle 法

服务器→GitHub 间歇断连（GnuTLS recv error / 连接超时）。补丁法（git apply）会留脏树；**bundle 法**补真实提交对象：

```bash
# 本地（注意：zsh+rtk 下 A..B 范围语法会误报"空捆绑包"，用 --branches --not）
git bundle create /tmp/fix.bundle --branches --not <server_head_sha>
scp /tmp/fix.bundle root@47.110.93.137:/tmp/
# 服务器
git fetch /tmp/fix.bundle <new_sha>:refs/remotes/origin/main
git reset --hard origin/main   # 干净收敛，真实历史无分叉
```

---

## 四、前端点击实测（浏览器端到端，全部通过）

| 操作 | 链路验证 | 结果 |
|---|---|---|
| 数据来源筛选（驾驶舱/职位市场/全部） | source_mode → 前端映射 → 筛选 + PUT preferences 200 | ✅（F3 修复后） |
| 暂不考虑 → 原因 toast → 提交 | POST feedback 200 → 落库（原因原文入库）→ 卡片移除 | ✅ |
| 撤销（feedback/undo） | 200 → 卡片回队列 | ✅（测试数据已还原） |
| 观察（打开详情） | VIEW 事件落决策轨迹；详情页"数据来源"正确 | ✅ |
| 加入我的项目 | PATCH membership 200 → MY_JOB | ✅（已还原 TEAM_SHARED） |
| 回放页签 | 冻结快照 + 事件轨迹渲染 | ✅ |
| 重新找人（OpenMai） | 点击 → running（task om_574e3cee）→ 32s done → 结果渲染 | ✅ |
| 控制台 | 全程 0 error / 0 warn | ✅ |

## 五、OpenMai 找人结果 Markdown 渲染（PR #35，46e1575）

用户反馈：找人结果 GFM（标题/候选人表格/档案链接）此前 `<pre>` 原文直出，表格源码、`openmai-table-artifact` 机器 JSON 块、`RECOMMENDED_IDS` HTML 注释全部直出。

- 新增 `app/openmai-markdown.ts`：**marked v18**（min ~90KB / gzip ~30KB，小包体；GFM 表格开箱即用；markdown-it 更重、snarkdown 不支持表格被否）
- 清洗：机器 JSON 块 / HTML 注释剥离；链接 `target=_blank rel=noopener`；作用域表格样式
- `.ts + createElement`（非 JSX）→ strip-types 单测直接 import；workbench.tsx 498 行基线持平（import 并入既有行）
- 测试 37/37 ✅；生产截图 `logs/brainx-openmai-markdown-render-20260831.jpeg`
- **观察**（非 bug）：同一职位两次找人结果形态可不同（首轮 4 位私域候选人 vs rerun 1 个可推荐岗位）——openmai LLM 任务行为差异，渲染管线两种形态均正确处理。

---

## 六、遗留与决定

| 项 | 状态 |
|---|---|
| BRAINX_DEV_AUTH=1 生产保留 | **用户 2026-08-31 决定暂留**（演示/离线登录需要）。风险：任何人 POST /api/v1/session 可冒充任意顾问。关闭方式：删 .env 该行 + restart brainx |
| Otto 石珅 openmai JWT 缺失 | 晨检 5/7（文档原记 6/7；York 缺失为设计跳过）。晨检退出码 1 可接告警 |
| same_company_shadow 34 对 | 待双建档合并策略（隔离报告可持续观测） |
| systemd units 未入仓 | brainx{,-worker,-shadow-daily,-retention}.{service,timer} 仅在服务器 /etc/systemd/system/，建议后续入 deploy/ |
| 磁盘 | 72%（余 5.4G）；frontend node_modules 1.1G 为最大剩余项（构建需要，保留） |
| R2 影子分歧 | Δ=0 居多仍属预期（样本 202 行）；impressions 积累 1-2 周后重训再看 |
