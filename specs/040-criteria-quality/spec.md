# specs/040-criteria-quality — 自动找人判据质量修复：规则底座 + 判据编译层（B）+ 结果校验层（C）

> 状态：待咪评审（2026-10-19 16:47 咪拍板「B+C 组合」，扩入原规则版设计）
> 建档：2026-10-19（零一）；扩展：2026-10-19（同日，B/C 并入）
> 优先级：P1（felix 三次质量投诉的根因修复）
> 交付分三阶段：**S1 规则底座**（§2-§5，零 LLM 成本）→ **S2 判据编译层 B**（§6，触发前 LLM 结构化判据）→ **S3 结果校验层 C**（§7，送达前必备项硬校验）。三阶段独立可上线、逐级降级兜底。

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

## 5. 验收标准（S1 阶段）

1. `tests/auto-search-criteria.test.mjs` 新增 ≥10 用例（上表），全过。
2. 生产 DB 三个真实 job_facts（J3ZJYBB/JWH6Q57/JH46A56）dry-run 生成判据，人工核对：销售向 JD 判据含销售语义、3-8 年生效、无年龄/性别字样、无「背景」倒置。
3. `npm run verify` full 通过。
4. 部署后首个新触发群的判据卡（buildSearchStartCard 会展示判据）由咪抽查。
5. **接线完备性断言（jdText 教训）**：测试必须证明 notes 分支真实执行（非仅函数签名存在）——用真实 notes 输入断言输出含「JD 原文要点」段。

---

## 6. S2 判据编译层（B）：触发前 LLM 结构化判据

> 咪拍板 2026-10-19 16:47。设计原则：**agent 路径质量高的本质是「对话经过了 agent 的理解整理」——B 层给自动路径装上同一个整理层**。对话原文直传不可取（J3ZJYBB 反证：role 全文传了照样泛化，问题在信息密度与结构，不在传没传）。

### 6.1 流程

```
触发（建群/回填/续搜）
  → 输入：job_facts.notes（JD 原文 + 小麦画像块）+ job 基础字段
  → S1 规则底座先跑（sanitize 剥歧视条件 + 年限/城市解析）——S1 结果作为 B 的输入与兜底
  → B：轻量 LLM（DeepSeek 级）编译 → 结构化判据 JSON
  → 拼接自然语言判据（引擎接口是文本 criteria）→ 落 search_brief（可审计）
  → 传引擎
```

### 6.2 结构化判据 schema（B 的输出契约）

```json
{
  "role_focus": "商务BD-广告主资源（销售向：客户开拓/谈判/回款/销售指标）",
  "hard_requirements": ["广告行业经验", "广告主资源（品牌方/效果代理/MCN）", "忌讳仅有大厂经验缺乏落地能力"],
  "preferences": ["互联网/科技公司广告销售经验", "AIGC 行业了解"],
  "exclusions": ["纯 PM/纯产品视角", "采购/IP引入背景（不能替代销售）"],
  "years_range": "3-8",
  "city_override": "广州",
  "city_source": "xiaomai_profile"
}
```

- 判据文本 = role_focus + 城市（city_override 优先于 job.city，**小麦画像优先原则**）+ 年限（years_range 优先于 S1 解析值）+ hard_requirements + preferences + exclusions 拼接，总长 ≤1200 字（search_brief 2000 上限内留余量）。
- **双重 sanitize**：LLM prompt 明确禁止输出年龄/性别/健康/婚育条件 + 出参正则兜底复检（S1 的 sanitizeJdNotes 规则复用）——LLM 约束不可信，必须出参硬校验。

### 6.3 降级与开关

- `BRAINX_CRITERIA_LLM=0`（默认开，kill switch）→ 直接走 S1 规则版判据。
- LLM 调用失败/超时（10s）/输出不合 schema → 落回 S1 判据，search_brief 记 `criteria_source: 'rules'`（B 成功记 `'llm_compiled'`）——**判据来源可追溯**，事后可统计两种来源的转化率差异。
- 成本：每次触发一次短 prompt（JD ≤500 字 + schema 指令），DeepSeek 级成本每次 < 分级。仅自动路径（建群/回填）走 B；agent 路径判据已由对话整理产生，不重复编译。

### 6.4 S2 边界用例

| # | 场景 | 期望 |
|---|---|---|
| B1 | JWH6Q57 真实 JD（3-8 年、忌讳大厂、字节 2-1） | hard_requirements 含「忌讳仅有大厂」；years_range=3-8；无「30岁以内」 |
| B2 | J3ZJYBB 真实 JD（销售向 + 画像广州 + 画像「销售不可替代」） | role_focus 含销售向语义；city_override=广州；exclusions 含「采购/IP引入背景」 |
| B3 | JH46A56 真实 JD（画像「不要纯 PM」「深圳优先」「无年限门槛」） | exclusions 含「纯 PM/纯产品」；city_override=深圳；years_range=null（不硬造） |
| B4 | LLM 输出夹带「35岁以下」 | 出参正则剥除；测试断言输出不含 |
| B5 | LLM 超时 | 落回 S1 判据，criteria_source='rules' |
| B6 | notes 为空 | 不调 LLM，直接 S1（省一次调用） |
| B7 | BRAINX_CRITERIA_LLM=0 | 全程无 LLM 调用 |
| B8 | LLM 输出 JSON 解析失败 | 落回 S1，不抛错不阻塞触发 |
| B9 | 续搜轮（round≥2） | 沿用首轮编译结果 + 追加 exclusions（不重复编译不重复付费） |
| B10 | 画像与 city 字段冲突（广州 vs 北京/上海） | city_override=画像值，city_source='xiaomai_profile'（可追溯） |

## 7. S3 结果校验层（C）：送达前 JD 必备项硬校验

> 引擎今天已输出逐人 [+] [-] 标注与「条件分类」，但排序仍可能让偏移人选进前排。C 层在我们侧用 B 的结构化必备项做最后一道硬校验——**降位为主，不默认剔除**（避免空手而归；明确配置才剔除）。

### 7.1 流程与位置

位置：`src/openmai-delivery.js` worker 生成结果卡**之前**（结果已落库、卡片未发——校验不影响落库事实，只影响展示顺序与标注）。

```
引擎结果落库（openmai_results.result_text，BRAINX_CANDIDATES_V1 JSON）
  → C：取 B 层结构化必备项（hard_requirements/exclusions）
  → 本地规则 + 轻量 LLM 逐人判定：候选人 role/evaluation 是否满足每条必备项
     → 每人 verdict: pass / warn / unknown（证据不足）
  → 重排：pass 在前 → unknown 居中 → warn 沉底；warn 的人卡片加「⚠️ 未通过 JD 必备项：具体条目」
  → 卡片顶部加「本批 N/10 通过 JD 必备项校验」
  → 投递（正常 SENT 链路不变）
```

### 7.2 校验判定规则

- 每条 hard_requirement 对每个候选人：**pass**（evaluation/role 明确支持）/ **warn**（明确冲突，如「忌讳大厂」vs「字节 5 年」）/ **unknown**（证据不足）。
- 任何一条 warn → 该候选人整体 warn（沉底 + 标注具体冲突条目）。
- 全 pass 或全 unknown 为主 → 保持引擎原序（不误伤对照组式的高质量批次）。
- **离线回放验收（零成本）**：用今天三个真实 result_text 回放 C 层——
  - JWH6Q57：10 个大厂人应在「忌讳仅有大厂」条目下多数 warn 沉底（胥欣/姜灿等字节阿里百度背景）；
  - J3ZJYBB：6 个投放优化岗应在「广告主资源/销售向」条目下 warn；谷歌广告销售/大客户商务经理应 pass 置顶；
  - JWZSVXQ（对照组）：10 人应基本 pass——**验证不误伤是 C 的核心验收项**。
- LLM 判定成本：每批一次调用（10 人 × ≤5 条必备项的结构化判定），短任务。失败降级：不校验、原序投递、卡片标注「校验未执行」。

### 7.3 S3 边界用例

| # | 场景 | 期望 |
|---|---|---|
| C1 | JWH6Q57 回放 | 大厂背景者 warn 沉底；顶部 N/10 计数正确 |
| C2 | J3ZJYBB 回放 | 投放岗 warn；谷歌销售/商务经理 pass 置顶 |
| C3 | JWZSVXQ 回放 | ≥8/10 pass，排序基本不变（不误伤） |
| C4 | hard_requirements 为空（B 未产出） | 跳过校验，原序投递 |
| C5 | 全员 warn（极端批次） | 沉底顺序仍输出，不剔除、不空手而归；卡片顶部如实标 0/10 |
| C6 | BRAINX_RESULT_VERIFY=0 | 跳过校验 |
| C7 | 校验 LLM 失败 | 原序投递 + 「校验未执行」标注，投递链路不受阻 |
| C8 | needs_input/failed 任务 | 不进 C 层（只校验 done 且有候选人的批次） |
| C9 | 续搜轮结果 | 同样过 C 层（exclusions 已由引擎执行，C 只管必备项） |
| C10 | warn 的人被顾问手动初筛通过 | 顾问操作不受 C 层限制（C 只影响展示，不写死决策） |

### 7.4 与 A2/B1 旧缺口的关系

C 层卡片标注复用 sourcing-result-card 的现有结构（warn 标注类似现有 [-] 风险行），freeform 群的 hint 渲染缺口（差距报告 B1）顺带在本次修复——freeform 结果卡也渲染 continueSearchHint。

## 8. 分阶段验收汇总

| 阶段 | 交付物 | 验收 |
|---|---|---|
| S1 规则底座 | sanitizeJdNotes/parseExperienceRange/招聘方语义 + 测试 | §5 五项 |
| S2 编译层 B | src/criteria-compile.js（新）+ kill switch + criteria_source 追溯 | §6.4 十项 + 三个真实 JD 编译输出人工核对 |
| S3 校验层 C | src/result-verify.js（新）+ 卡片重排标注 + 回放测试 | §7.3 十项 + 三案例离线回放（含对照组不误伤） |

上线序：S1 → S2 → S3，每阶段独立可回滚（kill switch 分别为 BRAINX_CRITERIA_LLM / BRAINX_RESULT_VERIFY，S1 无开关属纯修正）。

---

## 9. S1.1 修订（下一步，2026-10-19 19:10 咪指令「构建下一步的方案」）：小麦画像块优先段

> 状态：待咪评审后实施。上线实证发现：**画像块整体位于 notes 末尾、S1 的 500 字截断边界之外**——JH46A56 dry-run 判据尾部可见截断残迹「小麦同步画像（最后更新 2」，「深圳优先」「不要纯 PM」未入判据。§6.2 的小麦画像优先原则在 S1（规则层）与 S2（prompt 输入）双双落空，需修订。

### 9.1 现状与缺陷

`job_facts.notes` = JD 正文 + `<!-- xiaomai-sync-begin --> … <!-- xiaomai-sync-end -->` 画像块（客户禁忌/必备能力/城市年限修正，判据最高价值素材）。S1 `sanitizeJdNotes` 截前 500 字，画像块在后 → 被截；S2 的 user prompt 沿用同一截断文本 → 画像同样进不了 LLM。

### 9.2 设计（改 `src/auto-search.js` + `src/criteria-compile.js` 输入）

1. 新增 `extractXiaomaiProfile(raw)`：正则提取画像块内容（`<!-- xiaomai-sync-begin -->([\s\S]*?)(?:<!-- xiaomai-sync-end -->|$)`，缺 end 标记兜底吃到尾），经 `sanitizeJdNotes` 净化，独立 200 字预算。
2. `buildAutoSearchCriteria` 改为三段拼装（顺序即优先级）：
   - `客户画像要点：${profile}`（≤200 字）——置于 JD 原文要点**之前**；
   - `JD 原文要点：${notes}`——notes 先剥离画像块再截 500 字（避免重复、把 500 字预算全部让给 JD 正文）；
   - 年限解析顺序：画像 → JD 正文 → 3-5 年兜底。
3. S2 输入同步：`compileSearchCriteria` 的 user prompt 把画像段单独置顶标注「客户画像（最高优先级）：」，与 §6.2 画像优先原则对齐。
4. 判据总长预算不变（500+200+基础字段 ≈ 900 字，search_brief 2000 内安全；S2 ≤1200 不变）。

### 9.3 边界用例

| # | 场景 | 期望 |
|---|---|---|
| P1 | JH46A56 真实 notes（画像块在 500 字外） | 判据含「客户画像要点：…深圳…不要纯 PM」；JD 正文段不含画像块内容 |
| P2 | 画像块含年限（如「无年限门槛」→无区间；「5-8年」） | 年限解析优先取画像值；「无年限门槛」解析不出则落 JD 正文值 |
| P3 | 画像与 JD 正文年限矛盾 | 画像优先 |
| P4 | 无画像块（旧数据/非小麦来源） | 行为与现行 S1 完全一致（回归保障） |
| P5 | 画像块内容全为歧视条件 | 剥完为空 → 无画像段，不输出空段 |
| P6 | 画像块缺 end 标记（同步中断残留） | 兜底吃到 notes 尾部，不抛错 |
| P7 | S2 prompt 结构 | 画像段置顶且标注最高优先级；无画像块时 prompt 形状不变 |

### 9.4 验收

1. 上述用例全过 + 存量 62 用例零回归（S1 现有用例中 notes 无画像块 → 输出不变）。
2. 生产 JH46A56 dry-run：判据含深圳/纯PM 语义，无截断残迹。
3. `npm run verify` full 通过；部署后首个新触发群判据卡由咪抽查。
