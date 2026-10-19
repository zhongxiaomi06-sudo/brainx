# specs/041-retrofill-timer-credential-scan — 每日自动回填 timer + 凭证到期主动扫描提醒

> 状态：待咪评审
> 建档：2026-10-19（零一）
> 优先级：P1（york 过期 6 天无人发现的教训 + 今日 6 顾问同日到期悬崖）

## 1. 背景

### 1.1 两个生产实证（2026-10-19）

1. **york 凭证 10-13 03:21 UTC 过期，到 10-19 无人发现**——6 天里他的 4 个 READY 群（JCGQ95P/JLKTY84/J7TV1E9/JUPN2TS）无法自动找人，系统静默（无 timer 扫描、无主动提醒；10-15 retrofill 时 SKIP no_jwt 发过一次提醒后归寂）。
2. **6 顾问凭证同日到期悬崖**：mia/linda/wendy/shanon/felix 今日 08:53-09:09 UTC 集体到期、otto needs_reauth=1。咪 10-19 15:39 拍板手工执行了重跑 + 一次性脚本私聊提醒（/tmp/cred-remind-1019.mjs，5 位 SENT）。**本 spec 把这两个手工动作产品化**。

### 1.2 现状缺口

- systemd timers 有 backup/oss-sync/feedback-rollup/talent-match/shadow-daily/retention，**无 retrofill timer**——存量 NULL 群只能靠人想起来跑。
- `notifyCredentialExpired` 只在「触发时撞上无效凭证」被动调用（autoSearchOnLaunch:164、retrofill:140）——没人触发就没人提醒。
- 咪拍板的长期目标「建群之后按 JD 就开始第一轮的找人，后续能一直长期招人」（specs/037 头部）依赖：凭证长期有效 + 存量群自动补搜。两块都缺自动轮询。

## 2. 设计

### 2.1 组件 A：`src/credential-scan.js`（新）

```js
/** credential-scan.js — 凭证健康扫描（specs/041）。
 *  扫 ttc_tokens：已过期 或 T-48h 内到期 或 needs_reauth=1 → 私聊提醒扫码更新。
 *  幂等：workflow_event_log idem_key=notify:cred-scan:<cid>:<YYYY-MM-DD>，同日不重发。
 *  跳过：mia（咪本人）、consultants.active=0 或 open_id IS NULL（otto 案实证：不可达）。 */
export async function scanCredentials(db) {
  // 1. SELECT t JOIN consultants c ON c.consultant_id=t.consultant_id
  //    WHERE c.active=1 AND c.open_id IS NOT NULL AND c.consultant_id != 'mia'
  // 2. 每行判定：needs_reauth=1 || expires_at <= now  → 已失效（红卡）
  //             expires_at <= now+48h                  → 48h 内到期（橙卡）
  //             其余跳过
  // 3. idem_key 查 workflow_event_log，当日已发跳过
  // 4. 卡片：准确状态文案 + 扫码三步指引 + 受影响 READY 项目 + 工作台按钮
  //    （复用 2026-10-19 手工脚本 /tmp/cred-remind-1019.mjs 已验证的文案结构）
  // 5. sendInteractiveCard + workflow_event_log 记账（event_type=credential.scan_reminder）
  // 返回 { scanned, reminded: [...], skipped: {...} }
}
```

卡片文案沿用今日实测送达的版本（5 位顾问已收到）：
- 红（已失效）：`你的 TTC 凭证已于 XX（北京时间）失效 N 小时。到期后自动找人、岗位同步、候选人搜索都会停止。`
- 橙（临期）：`你的 TTC 凭证将于 XX（北京时间）到期，剩余 N 小时。`
- 指引：`① 打开 app.ttcadvisory.com ② 用飞书扫码登录 ③ 装了「BrainX TTC 凭证自动同步」扩展的自动完成；未装的在工作台 → 设置中心 → 「TTC 职位系统」粘贴 JWT`
- 受影响项目：该顾问 READY 群 project_id 列表（≤10）

### 2.2 组件 B：每日 systemd timer（部署物，非仓库代码）

`/etc/systemd/system/brainx-cred-scan.service` + `brainx-cred-scan.timer`：

```ini
# service
[Service]
Type=oneshot
User=brainx
WorkingDirectory=/opt/brainx
ExecStart=/usr/bin/node /opt/brainx/bin/brainx-cred-scan.mjs
EnvironmentFile=/etc/brainx/openclaw.env

# timer
[Timer]
OnCalendar=*-*-* 03:20:00 Asia/Shanghai
Persistent=true
```

`brainx-auto-search-retrofill.timer` 同款（03:40 跑，scan 在前——凭证无效的群 retrofill 自动 SKIP no_jwt 且当轮已提醒）：

```ini
[Timer]
OnCalendar=*-*-* 03:40:00 Asia/Shanghai
Persistent=true
```

`bin/brainx-cred-scan.mjs`（新，仓库内）：加载 env（照抄 retrofill 头部模式）→ `openDb` → `scanCredentials(db)` → 输出摘要退出。retrofill 已有的 `nohup` 手跑用法保留，timer 只是加一层自动兜底。

### 2.3 与 038 的依赖关系

每日 retrofill 与手工/建群触发共享 `openmai_results` 主键。038（INSERT 前 DB running 拦截）实施前，timer 化会**放大**跨进程顶替 hazard（每日 03:40 自动 spawn + 人工白天触发）。**依赖序：038 先行，041 的 retrofill timer 后上**；credential-scan timer 无此依赖，可先行。

## 3. 边界用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | york 式：expires_at 过去 6 天 | 红卡 + 受影响项目 6 个 |
| 2 | felix 式：剩余 2h | 橙卡「剩余 2.0 小时」 |
| 3 | 当日已发过（idem_key 命中） | 跳过不重发 |
| 4 | mia（咪本人） | 跳过 |
| 5 | otto 式：active=0 或 open_id=null | 跳过并在摘要输出 unreachable 名单 |
| 6 | 无 token 行的顾问 | 不在扫描集（JOIN 自然过滤） |
| 7 | 顾问当日扫码更新后二次扫描 | getValid 逻辑之外，scan 只看 ttc_tokens 现值：已续期 → 不提醒；已提醒过的当日不撤回（幂等键不变） |
| 8 | 飞书 API 失败 | 该顾问记 failed 不中断其他顾问，退出码仍 0（提醒是 best-effort） |
| 9 | retrofill timer 遇 NULL 群凭证无效 | SKIP no_jwt + 当轮 scan 已提醒（时序：03:20 scan < 03:40 retrofill） |
| 10 | timer 落后补跑（机器重启） | Persistent=true 补跑一次；幂等保证不重复发 |

## 4. 回归风险

- **打扰密度**：T-48h + 已失效两档、同日幂等——最坏情况一位顾问一天一张卡。咪 10-15 拍板过「凭证失效 agent 私聊主动提醒」方向（specs/037 §4.4.1），本 spec 是其定时化，不改变打扰上限。
- **timer 与手动 nohup 并发**：038 未上前，理论存在同群同时触发（03:40 自动 + 人工白天）→ 038 拦截兜底；依赖序已声明。
- **凭证提醒卡片与建群欢迎卡/找人卡的时序**：不同 target（私聊 vs 群），无冲突。
- systemd timer 全部走 `Persistent=true`，防止停机日漏扫。

## 5. 验收标准

1. `tests/credential-scan.test.mjs`（新）：边界用例 1-8，mock sendInteractiveCard，全过。
2. 生产 dry-run：`node bin/brainx-cred-scan.mjs --dry-run` 输出当日应提醒名单与咪 10-19 手工执行结果一致（york 红/felix-linda-wendy-shanon 橙/otto unreachable）。
3. timer 部署后 `systemctl list-timers` 可见两个 timer；次日手动 `systemctl start brainx-cred-scan` 幂等（同日不重发）。
4. `npm run verify` full 通过。
5. 部署链：scp service/timer 两对 unit 文件 → daemon-reload → enable --now → `journalctl -u brainx-cred-scan` 首跑成功。
