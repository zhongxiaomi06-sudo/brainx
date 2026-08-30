---
name: brainx-report
description: 用 BrainX 数据产出报告素材:顾问周报、客户公司报告、职位盘点、推荐质量分析(机器人以结构化文本/markdown 产出;要 docx/xlsx 文件时指引用户在支持文件产出的桌面端用同款数据)。
---

# BrainX 数据报告(产品内文本版)

固定动线:**取数 → 核算 → 结构化产出 → 标注口径**。报告里只写查到的数,缺口标"无数据",不估算编造。

## 取数配方

| 报告 | 工具 |
|---|---|
| 顾问周报 | `brainx_workbench` + `query_sql`:本周 decision_events / job_outcomes / commitment_actions 完成项 |
| 客户公司报告 | `brainx_clients` + `query_sql`:job_facts 按 company 聚合 + 各职位最新事件 |
| 职位盘点 | `query_sql`:job_facts ⋈ job_occupancy ⋈ job_classifications |
| 推荐质量 | `query_sql`:recommendations ⋈ job_outcomes 转化;影子评估见 brainx-ops 的 shadow-daily |

## 快捷 SQL

```sql
-- 本周动态(把 ? 换成当前 consultant_id)
SELECT event_type, project_id, occurred_at FROM decision_events
WHERE actor=? AND occurred_at >= date('now','-7 days') ORDER BY occurred_at;

-- 职位盘点底表
SELECT j.project_id, j.company, j.role, j.city, j.active_state,
       c.primary_direction, o.occupancy_status, o.remaining_hc
FROM job_facts j
LEFT JOIN job_classifications c USING(project_id)
LEFT JOIN job_occupancy o USING(project_id);

-- 推荐→结果转化
SELECT r.action, count(*) n,
       sum(CASE WHEN o.stage IN ('面试','Offer','入职') THEN 1 ELSE 0 END) converted
FROM recommendations r LEFT JOIN job_outcomes o USING(project_id, consultant_id)
GROUP BY 1;
```

## 产出规范

- 报告头固定三行:数据快照时间(最新 sync_runs.completed_at)/ 口径(数据来源表或工具)/ 生成人(BrainX 助手)
- 关键数字在尾部附"取数方式"附录(用了哪个工具/SQL)
- 表格用 markdown;长报告分节(概览 → 明细 → 风险/缺口 → 建议动作)
- 建议动作一律走 brainx-engagement 的"建议+指引"剧本,不写成"已执行"
