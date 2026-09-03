# 猎头蒸馏:Felix 黄鑫(素材稿 v0,待本人确认)

> meta: 2026-08-31 | 版本 v0 | 素材来源:BrainX 生产库(事件账本/承接/反馈/人工覆盖/群消息,截至当日)| 完成度 ~35%(纯素材段)| 断点:无
> **本稿零采访生成。所有 `# 待确认` 段是 15 分钟确认访谈要问的;未标注段均有库内证据。**

## 1. 基本信息

- 花名:Felix(黄鑫);方向画像(库内):增长/投放/广告(待确认:职级/年限/行业细分)

## 2. 工作流轨迹表(素材可证部分)

```yaml
workflow:
  - step: 接单判断(值不值得做)
    actions: [推荐榜扫读, 快速划过标记, 不感兴趣反馈(带原因)]
    tools: [BrainX 工作台]
    duration: 单职位数秒      # "快速划过"×9 佐证;待确认
    judgment: 方向匹配一票否决(23/35 条反馈原话为"方向不符/方向不对")
    automation: B             # 待确认
    detectability:            # 待确认
    automate_what: 按方向的初筛降权(系统已在做)
    never_automate: 接单/放弃的最终决定(待确认)
    data_now: BrainX recommendation_feedback
  - step: custom:承接与优先级
    actions: [ACCEPT 接单, RELEASE 释放(带原因), 行动项跟进]
    tools: [BrainX]
    judgment: 释放主因是精力/资源("资源不足"×2,"当前无法投入","当前没精力")+岗位去重("岗位重复")
    automation: C             # 待确认
    detectability:            # 待确认
    data_now: BrainX decision_events / commitment_actions
  - step: 简历搜寻
    actions: [openmai推荐, 寻访, 找新人]
    tools: [OpenMai(接单自动触发)]
    automation: A             # 进行中;待确认:机器结果的人工复核比例
    detectability:            # 待确认
    data_now: BrainX openmai_results
  - step: CRM 录入与数据维护
    actions: [人工事实覆盖:状态/阶段/管线/HC/备注]
    tools: [BrainX 覆盖层]
    judgment: 系统数据滞后时人工改(例:爱诗科技五连改)
    automation: B             # 待确认
    detectability:            # 待确认
    data_now: BrainX manual_fact_overrides
  - step: 结果反馈与复盘
    actions: [结果录入:推荐采纳→面试]
    automation: C             # 待确认
    detectability:            # 待确认
    data_now: BrainX job_outcomes
# 素材覆盖不到的环节(必须访谈补):需求澄清、首次触达、跟进培育、推荐报告、面试辅导、offer 谈判、保过期
```

## 3. 判断规则清单(全部原话)

- **方向不符 → 直接不感兴趣** —"方向不符"(×23)/"方向不对"
- **低分低置信 → 快速划过不细看** —"快速划过"(×9)
- **产品类岗位不做** —"不做产品岗位"/"产品岗位不合适"(×2)(待确认:是所有产品岗还是特定行业)
- **精力不够 → 宁放不接** —"当前无法投入:当前精力不够"(Goodnotes 释放,接后次日即放)
- **岗位重复 → 释放** —"资源不足:岗位重复"(像素律动)
- **接了发现没资源 → 当天释放** —"资源不足:当前无时间"(Refly,接放同日)
- **系统状态过期 → 人工改成真实状态** —爱诗科技:active_state→"COMPLETED",current_stage→"UNKNOWN",pipeline→"Onboarding×1",notes→"创新增长,活动+投放,国内+海外AI项目背景",remaining_hc→1

## 4. 话术库

(素材不足:触达/催反馈/谈判话术在飞书群消息里,需授权按 sender 提取或本人贴聊天记录)

## 5. 真实案例线索(待本人补细节)

- **像素律动 运营增长:三接三放**(8-21 接→放,8-26 接→放)——什么信号让你反复?(待确认)
- **Goodnotes 内容增长运营:次日即放**——接的时候判断依据 vs 次日什么变了?(待确认)
- **爱诗科技:五字段人工覆盖**——系统滞后多久?你怎么拿到真实状态的?(待确认)

## 6. 转化率与节奏(库内实测)

- 近两周动作:VIEWED 51 / ACCEPTED 8 / RELEASED 4 / DISMISSED 2
- 接→放率:50%(8 接 4 放)(待确认:常态还是近期特殊)
- 漏斗:推荐采纳 2 → 面试 1(库内期)(待确认:库外还有多少)

## 7. Correction 记录

(暂无——本稿待本人首次确认后生成)

## 8. 素材缺口清单

1. 需求澄清/JD 解读过程(库外,需访谈或贴与客户沟通记录)
2. 触达与跟进话术(可授权从 job_messages 按 sender 提取,或本人贴聊天记录)
3. 推荐报告样式与面试辅导(需贴一份脱敏推荐报告)
4. offer 谈判与保过期(需访谈,约 10 分钟)
5. 各 automation 分级 + detectability 确认(全稿逐条过,约 5 分钟)
