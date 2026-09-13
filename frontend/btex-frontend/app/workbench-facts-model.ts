// 判断面板事实行的展示筛选（2026-09-13 二轮精简）：只保留决策必需行；
// 来源、时间戳、层级枚举等内部字段只供卡片与内部逻辑使用，不进判断面板。
// 「判断依据」由决策层级 + 事实可信度合成一行，替代原来的四行内部字段。
// 抽成无 JSX 的纯模块，便于在 node 测试中直接验证。
export const judgementFactOrder = ["职位关系", "主做顾问", "职位状态", "当前阶段", "剩余 HC", "历史 Pipeline", "下一步动作", "城市", "备注"];

export function judgementRows(facts: Record<string, string>): [string, string][] {
  const rows = judgementFactOrder
    .filter((label) => facts[label] !== undefined && facts[label] !== "")
    .map((label) => [label, facts[label]] as [string, string]);
  const basis = [facts["决策层级"], facts["事实可信度"]].filter((value) => value !== undefined && value !== "").join(" · ");
  if (basis) rows.push(["判断依据", basis]);
  return rows;
}
