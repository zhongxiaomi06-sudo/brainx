# 前端视觉规范统一复核（对比度 / 标题格式 / 术语本地化）

> 上级入口：[前端审核台账](README.md)

## 审核身份

- 审核日期：2026-09-12
- Storybook 场景：应用外壳、推荐队列 V2（首批/窄屏）、居中职位事实卡、我的项目行动工作台、设置中心、客户洞察、工作台控件、精选盘队列
- 对应 commit：见 `docs/AGENT_COMMIT_LOG.md` 2026-09-12 视觉规范统一条目
- 审核范围：前端视觉审计报告（`outputs/2026-09-12-frontend-audit/index.html`）中 BrainX 前端部分的全部结论，不含飞书群卡片（F1–F8 已由前序轮次处置）

## 背景

2026-09-12 晚的前端审计发现三类系统性问题：设计令牌三层同名定义互相覆盖导致 `--blue==--green==--cyan`
语义失效、主按钮与眉标小字对比度约 1.9:1 不达标、术语中英混排不统一（PIPELINE/INTERVIEW/TTC POSITION FACT），
且每个页面都有冗余的英文眉标层。本记录登记这一轮的修复与验证。

## 用户结论

- 已确认：用户指令「五个结论共同修改，今天完整，统一格式」，授权直接修复并提交。
- 未确认：修复后的视觉效果尚未经用户逐页过目；本记录只证明技术核查与本地验证通过。
- 正式接入授权：限定入口——改动全部在已接入的正式组件内，无新增入口。

## 改动摘要

1. **令牌收敛**：`--blue/--green` 统一为深绿 `#176B58`（文字/按钮用途，对比度约 7:1），亮薄荷
   `#2FD3A7` 只作装饰走 `--accent`；删除 `workbench-concept.css` 对共享令牌的全局覆写；
   补齐 `--font-mono`、`--body-cn` 定义；`.tag.green` 与 `.tag.blue` 合并为同一条规则。
2. **标题格式统一**：删除全部英文眉标层（MY PROJECTS / CLIENT FACTS / SETTINGS / TTC POSITION FACT /
   RECOMMENDATION POLICY / DIRECTION PROFILE / PICK FOLDERS / MY PICK TRAY / BRAINX ASSISTANT /
   CONTEXT ASSISTANT / CLIENT FACT / TTC JOB FACTS / TODAY DECISION / ALL POSITIONS），
   全站统一为「中文标题 + 一句中文描述」；`Heading` 组件移除 `code` 参数。
3. **术语本地化**：卡片事实标签 `Pipeline`→`进展`；阶段枚举按
   `src/job-extract/schema.js#PIPELINE_STAGES` 映射为寻访/筛选/面试/Offer/入职/已关闭；
   `TTC CRM 职位快照`→`来源快照`；pipeline 标签补 screening/closed。
4. **字号**：推荐队列 V2 卡片微标签 8px→11px、值 10px→12px、操作按钮 10px→12px、分页 10px→12px。
5. **死代码清理**：删除不可达的「动态预警」假数据页（Alerts）、假「判断依据」抽屉
   （含虚构置信度 91% 与固定评分条）、`Page` 类型的 `alerts` 成员；`workbench.tsx` 499→495 行。
6. **微文案**：助手「正在查:{tool}…」改为「正在查询相关资料…」；精选盘「已收藏」摘要补断句；
   机会区分组眉标改中文「已加入项目 / 未加入项目」（避开测试禁用的旧「接单」口径）。

## 数据与动作边界

- 真实字段：无变化；本次只动视觉层与展示文案，不动接口契约。
- 后端依赖：无新增。
- 允许动作：无新增。

## 状态证据

- 正式入口：改动即正式组件（workspace-shell、projects-view、client-insights-review、settings-center-review、
  job-detail-card-review、recommendation-queue-v2-review、workbench 系列）。
- 自动验证：`tsc --noEmit` 0 错误；`npm test`（btex-frontend）44/44；`storybook:test` 85/85；
  `storybook:build` 成功。计算样式实测：`.btn.primary` 背景 `rgb(23,107,88)`（#176B58）。
- 真实数据验证：本地 Storybook 截图复核（对比度、无英文眉标、进展/面试本地化、字号可读），
  真实数据页需飞书会话，待目标环境发布后经用户过目复核。

## 未完成项

- [ ] 用户逐页视觉复看（本记录不得替代用户审核维度）
- [ ] 目标环境发布与真实数据验证
- [ ] 前端仓库外两个项目已同步修复：BrainTex 静态站（命名收敛/空态引导）与
      Reloop 网页（错误横幅 HTML 泄漏、中文标题负字距），两者不在本仓库发布链路内
