# specs/040-criteria-quality — 自动找人判据质量修复：JD 原文入判据 + 招聘方语义修正 + 真实年限解析

> 状态：待咪评审
> 建档：2026-10-19（零一）
> 优先级：P1（felix 三次质量投诉的根因修复）

## 1. 背景：为什么 felix 表示「不准确」

felix 三次质量投诉（lark_messages 实证）：09-15「你这个base地点不对啊！！！我要求的是杭州或者上海的人，你怎么推荐的北京的」；10-13「你给推的这些人不算特合适，怎么样能让你进行修改呢」；10-15「老大，这个群的找人不准点」。

### 1.1 根因实证（不是引擎问题，是判据供给问题）

**对比实验**（同引擎、同库、同一天）：

| 案例 | 判据来源 | 判据内容 | 结果质量 |
|---|---|---|---|
| JWZSVXQ round5（om_420bdf6f） | agent/人工路径 | 「出海/海外 UA 投放岗；精通 Meta/Google/TikTok 实操；base 上海；跨品类（非纯游戏垂类）」 | **98%→83%，10/10 上海、10/10 对口**，排除名单精确执行 |
| JH46A56（sm_d6a203ec） | 自动路径 buildAutoSearchCriteria | 「Agent 软件技术负责人，北京市，1人，Zettlab吾云创新背景，主要做Interview×4…，3-5 年工作经验」 | 0/10 命中公司背景、IC 混排、判据含漏斗污染（10-15 修复前） |
| JWH6Q57（sm_b2582fcf，今日重跑） | 自动路径（污染已清洗） | 「AI产品运营增长-toc，北京市，1人，北京耳朵时间科技有限公司背景，3-5 年工作经验」 | 92%→80%，10/10 北京、岗位对口；**但 10 人全大厂（字节×3/百度×2/阿里/美团）** |
| J3ZJYBB（sm_fab9e96b，今日重跑） | 自动路径 | 「商业化运营/商务BD-广告主资源方向，北京市、上海市，1人，上海天码形空科技有限公司（OiiOii）背景，3-5 年工作经验」 | 城市命中；**但 10 人中 6 人是广告投放/优化岗，真正「商务BD-广告主资源」仅 2 人** |

**关键差异**：JWZSVXQ 的高质量判据携带了 JD 的真实语义（技能/品类/排除项）；自动路径判据只有 role+city+hc+company+3-5年，把 JD 里真正决定「准」的信息全部丢了。

### 1.2 三处具体断点（全部有 DB 实证）

1. **JD 原文就在库里但从未入判据**：`job_facts.raw_json.notes` 含完整 JD（J3ZJYBB：「独立开拓广告主客户资源…负责商务谈判、合同签订及回款跟进，完成销售指标」=销售向；JWH6Q57：「3-8年工作经验…0-1产品增长运营背景…目标公司不限，但忌讳仅有大厂经历」）。而 `buildAutoSearchCriteria(job)`（auto-search.js:173、retrofill:162）**从未传第二参数 jdText**——line 62-65 的 jdText 分支（技能要求拼接）在生产从未执行过。
   - JWH6Q57 铁证：JD 明说「**忌讳仅有大厂经历**」，自动判据只给 role+city → 引擎按关键词推回 10 个大厂人 → 这就是 felix 眼里的「不合适」。
   - J3ZJYBB 铁证：JD 职责是「开拓广告主客户/商务谈判/回款/销售指标」（销售向），role 字符串被引擎泛化为「商业化/广告运营、广告销售或商务BD」三方向 → 供给最大的「广告投放优化」池占 6/10。
2. **company 背景语义倒置**（auto-search.js:57）：`${job.company}背景` = 给 X 公司的岗位找「X 背景」的人。引擎今日两次自行补偿（「按职位所属公司处理」「未作为候选人过滤条件」——sm_fab9e96b/sm_b2582fcf 结果文本实证），但每次靠引擎猜，猜错一次全批偏移。JH46A56 案（修复前）：0/10 命中「Zettlab 背景」，引擎自己都标注「请重点确认这条是否硬性」。
3. **固定 3-5 年覆盖真实区间**（auto-search.js:68，咪 2026-10-15 拍板的默认值）：JWH6Q57 的 JD 明确「3-8 年工作经验【必须项】」，自动判据硬写 3-5 年，硬条件失真。

### 1.3 附带发现（engine 侧，不在本 spec 范围）

IC/Lead 混排：JH46A56 十人中 5 人偏 IC 排进「技术负责人」岗位前 10（引擎已诚实标注「偏 IC 非负责人」）。JD notes 明确「负责软件研发团队的搭建与管理」——**notes 入判据后此问题自动缓解**，故不单列修复项，验收时观察。

## 2. 设计

### 2.1 修改 `src/auto-search.js#buildAutoSearchCriteria`

```js
export function buildAutoSearchCriteria(job, jdText = null) {
  if (!job || (!job.role && !job.company)) return null;

  const parts = [];
  if (job.role) parts.push(job.role);
  if (job.city) parts.push(job.city);
  if (job.hc) parts.push(`${job.hc}人`);

  // 【改 1】招聘方语义修正：不再拼「X背景」（倒置语义），改为括号标注招聘方
  if (job.company) parts.push(`（招聘方：${job.company}）`);

  // 【改 2】pipeline 业务描述（不变，cleanPipeline 保留）
  const pipeline = cleanPipeline(job.pipeline);
  if (pipeline) parts.push(`主要做${pipeline}`);

  // 【改 3】JD 原文入判据：notes 经 sanitize 后截取，jdText 参数显式传入仍优先生效
  const notes = sanitizeJdNotes(job.notes) || sanitizeJdNotes(jdText);
  if (notes) parts.push(`JD 原文要点：${notes}`);

  // 【改 4】年限解析：notes/jdText 含显式年限区间时用真实值，否则保留 3-5 年兜底
  const years = parseExperienceRange(notes) || '3-5 年';
  parts.push(`${years}工作经验`);

  return parts.join('，');
}
```

新增两个纯函数（同文件导出，便于测试）：

```js
/** JD 原文净化：剥年龄/性别/健康等歧视性或不可执行条件 + 规整空白。 */
export function sanitizeJdNotes(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/\r\n/g, '\n');
  // 年龄类：30岁以内 / 35 岁以下 / 年龄限制：XX / XX岁以内优先
  t = t.replace(/年龄限制[：:]?[^\n。；;]*[。；;\n]?/g, '');
  t = t.replace(/\d{2}\s*岁以[内下][^\n。；;,，]*[。；;\n,，]?/g, '');
  // 性别类（f94b3d3 先例：引擎已约束不转 gender 过滤，判据侧同步不供给）
  t = t.replace(/(女|男)生?优先[^\n。；;,，]*[。；;\n,，]?/g, '');
  t = t.replace(/限(女|男)性[^\n。；;,，]*[。；;\n,，]?/g, '');
  // 压缩空白，截取前 500 字（现 jdText 分支 200 字太短，J3ZJYBB 职责列表 200 字只到一半）
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t ? t.slice(0, 500) : null;
}

/** 解析显式年限区间：「3-8年」「3-8 年工作经验」「5 年以上」→ '3-8 年' / '5 年以上'；解析不出返回 null。 */
export function parseExperienceRange(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s*[-–~至]\s*(\d{1,2})\s*年/);
  if (m) return `${m[1]}-${m[2]} 年`;
  const m2 = text.match(/(\d{1,2})\s*年以上/);
  if (m2) return `${m2[1]} 年以上`;
  return null;
}
```

### 2.2 调用方不变

`autoSearchOnLaunch:173` 与 `retrofill:162` 保持 `buildAutoSearchCriteria(job)` 裸调——notes 从 `job.notes`（`SELECT *` 已含）自动进入，无需传参。显式 `jdText` 参数保留（agent 路径未来可传对话原文覆盖）。

### 2.3 判据长度预算

现上限 search_brief 2000 字（CLI `criteria.slice(0, 2000)`）不变。notes 500 字 + 基础字段 ~100 字，总量安全。

## 3. 边界用例

| # | 输入 | 期望 |
|---|---|---|
| 1 | job.notes 含「3-8年工作经验」+「30岁以内」+「忌讳仅有大厂经历」（JWH6Q57 真实数据） | 年限段=「3-8 年工作经验」；notes 不含「30岁以内」；含「忌讳仅有大厂经历」 |
| 2 | job.notes 为销售向 JD（J3ZJYBB 真实数据） | 判据含「JD 原文要点：…开拓广告主客户资源…商务谈判…完成销售指标」 |
| 3 | job.notes=null, jdText=null | 无「JD 原文要点」段；年限兜底「3-5 年工作经验」（咪拍板默认） |
| 4 | job.notes 含「女生优先」 | 剥离，判据无性别字样 |
| 5 | notes 超长（>500字） | 截 500 字，不超 search_brief 预算 |
| 6 | company='Zettlab吾云创新' | 输出含「（招聘方：Zettlab吾云创新）」，**不含**「Zettlab吾云创新背景」 |
| 7 | notes 年限「5 年以上」 | 年限段=「5 年以上工作经验」 |
| 8 | notes 年限矛盾（「3-8年」与「5年以上」并存） | 取首个匹配（3-8 年），不抛错 |
| 9 | jdText 显式传入 + job.notes 也有 | notes 优先（job 字段比外部文本可信）；测试断言二选一 |
| 10 | CRLF 行尾的 notes | 剥离正常（specs/039 的 CRLF 教训） |
| 11 | notes 全部内容都是年龄/性别条件（剥完为空） | 无「JD 原文要点」段，不输出空段 |
| 12 | 兼容回归：pipeline 漏斗计数（sm_bafc5d0f 案例） | cleanPipeline 行为不变 |

## 4. 回归风险

- **agent 路径不受影响**：tools-sourcing 判据由对话生成，不经 buildAutoSearchCriteria。
- **续搜判据**：continuing 路径沿用首轮 brief + exclusions，首轮判据变长后续搜 prompt 相应变长——引擎 token 预算需在验收时观察（500 字在安全量级）。
- **已 done 项目不重跑**：already_done 检查保证存量 done 任务不重复付费；新判据只影响新触发/重试的群。
- **hash 键变化**：`supermaiCriteriaKey(criteria)` 按判据文本 hash——判据变化 → 合成键变化 → 自由找人主键换位。检查点：038 实施后 INSERT 有 running 拦截，此风险由 038 兜底；038 未实施前，CLI 仅显式调用（无自动路径传合成键），风险可控。
- **验收基线**：J7AKNAL 判据会从「…上海随便找个信息科技有限公司背景，3-5 年…」变化——`tests/auto-search-criteria.test.mjs` 现有用例需同步更新（「保留真实 pipeline 业务描述」用例的公司背景断言）。

## 5. 验收标准

1. `tests/auto-search-criteria.test.mjs` 新增 ≥10 用例（上表），全过。
2. 生产 DB 三个真实 job_facts（J3ZJYBB/JWH6Q57/JH46A56）dry-run 生成判据，人工核对：销售向 JD 判据含销售语义、3-8 年生效、无年龄/性别字样、无「背景」倒置。
3. `npm run verify` full 通过。
4. 部署后首个新触发群的判据卡（buildSearchStartCard 会展示判据）由咪抽查。
