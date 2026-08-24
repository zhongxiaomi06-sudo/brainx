import { cockpitRadarCompanies } from "./cockpit-radar-data";
import type { Job, PositionType } from "./workbench-model";

export const jobs: Job[] = [
  {
    id: 1,
    name: "AI 广告销售负责人",
    client: "星河科技",
    industry: "人工智能",
    city: "上海",
    pm: "林书言",
    status: "升温",
    score: 92,
    hc: 3,
    feedback: "2小时前",
    recommended: 8,
    interview: 3,
    offer: 0,
    reason: "48小时反馈提速，HC由2增至3",
    salary: "70–100K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 2,
    name: "海外增长负责人",
    client: "纬度引擎",
    industry: "跨境电商",
    city: "深圳",
    pm: "周既明",
    status: "拥挤",
    score: 78,
    hc: 2,
    feedback: "5小时前",
    recommended: 14,
    interview: 5,
    offer: 1,
    reason: "已有5人面试，竞争进入高位",
    salary: "60–85K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 3,
    name: "商业化增长经理",
    client: "棱镜互动",
    industry: "营销科技",
    city: "北京",
    pm: "许嘉禾",
    status: "降温",
    score: 63,
    hc: 1,
    feedback: "3天前",
    recommended: 9,
    interview: 1,
    offer: 0,
    reason: "反馈放缓且预算低于市场中位数",
    salary: "35–45K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 4,
    name: "AI 产品运营负责人",
    client: "澄明智能",
    industry: "人工智能",
    city: "杭州",
    pm: "沈青",
    status: "活跃",
    score: 86,
    hc: 2,
    feedback: "8小时前",
    recommended: 6,
    interview: 2,
    offer: 0,
    reason: "客户连续两轮在24小时内反馈",
    salary: "50–75K",
    source: "市场信号",
    positionType: "产品",
  },
  {
    id: 5,
    name: "Creator Partnership 负责人",
    client: "远屿网络",
    industry: "内容平台",
    city: "上海",
    pm: "陆弦",
    status: "新发布",
    score: 82,
    hc: 4,
    feedback: "1天前",
    recommended: 3,
    interview: 0,
    offer: 0,
    reason: "新发布且4个HC，需求画像已确认",
    salary: "45–65K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 6,
    name: "海外渠道销售",
    client: "云帆智能",
    industry: "企业服务",
    city: "深圳",
    pm: "林书言",
    status: "疑似失活",
    score: 41,
    hc: 2,
    feedback: "7天前",
    recommended: 11,
    interview: 1,
    offer: 0,
    reason: "连续7天无反馈，剩余HC未确认",
    salary: "40–60K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 7,
    name: "用户增长负责人",
    client: "拾光生活",
    industry: "消费科技",
    city: "北京",
    pm: "周既明",
    status: "升温",
    score: 88,
    hc: 2,
    feedback: "4小时前",
    recommended: 7,
    interview: 3,
    offer: 1,
    reason: "新增Offer且反馈时间缩短至12小时",
    salary: "55–80K",
    source: "市场信号",
    positionType: "运营",
  },
  {
    id: 8,
    name: "增长策略负责人",
    client: "矩阵工场",
    industry: "SaaS",
    city: "杭州",
    pm: "沈青",
    status: "活跃",
    score: 80,
    hc: 1,
    feedback: "20小时前",
    recommended: 5,
    interview: 2,
    offer: 0,
    reason: "面试转化稳定，业务负责人持续参与",
    salary: "50–70K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 9,
    name: "AI 解决方案销售",
    client: "澄明智能",
    industry: "人工智能",
    city: "北京",
    pm: "许嘉禾",
    status: "拥挤",
    score: 72,
    hc: 3,
    feedback: "9小时前",
    recommended: 18,
    interview: 6,
    offer: 1,
    reason: "参与顾问增至6人，推荐密度过高",
    salary: "45–70K",
    source: "市场信号",
    positionType: "商业化",
  },
  {
    id: 10,
    name: "国际化产品增长",
    client: "远屿网络",
    industry: "内容平台",
    city: "上海",
    pm: "陆弦",
    status: "已关闭",
    score: 0,
    hc: 0,
    feedback: "2天前",
    recommended: 12,
    interview: 4,
    offer: 1,
    reason: "客户确认HC已全部关闭",
    salary: "45–65K",
    source: "市场信号",
    positionType: "产品",
  },
];

export const cockpitRoleColumns = [
  { key: "technical", label: "技术岗", fallback: "技术" },
  { key: "productOps", label: "产运岗", fallback: "运营" },
  { key: "algorithm", label: "算法岗", fallback: "算法" },
] as const satisfies readonly { key: "technical" | "productOps" | "algorithm"; label: string; fallback: PositionType }[];

export function splitCockpitRoles(value: string) {
  const titles: string[] = [];
  let title = "";
  let nesting = 0;
  const push = () => {
    const next = title.replace(/^[-•·\s]+|\s+$/g, "").trim();
    if (next && next !== "—" && next !== "暂无") titles.push(next);
    title = "";
  };
  for (const char of value.replace(/\r/g, "\n")) {
    if (char === "（" || char === "(") nesting += 1;
    if (char === "）" || char === ")") nesting = Math.max(0, nesting - 1);
    if ((char === "\n" && nesting === 0) || "、；;".includes(char)) {
      push();
      continue;
    }
    title += char;
  }
  push();
  return titles;
}
export function classifyCockpitRole(title: string, fallback: PositionType): PositionType {
  const value = title.replace(/\s+/g, " ").trim();
  if (/设计|UI\s*\/?\s*UX|视觉/i.test(value)) return "设计";
  if (/算法|大模型|机器学习|深度学习|研究|Research|MLE|VLM|NLP|RAG|LLM/i.test(value)) return "算法";
  if (/运营|社群|社区|助理|财务|FA\b|KOL/i.test(value)) return "运营";
  if (/产品(经理|负责人|总监|设计|策略|运营|市场|增长|商业化|&)|\bPM\b|Product/i.test(value)) return "产品";
  if (/增长|市场|投放|销售|商务|品牌|GTM|售前|招聘|HR|BD|营销|内容|CMO/i.test(value)) return "商业化";
  if (/工程|研发|开发|前端|后端|全栈|运维|测试|架构|技术|CTO|iOS|Android|Engineer/i.test(value)) return "技术";
  if (/产品/i.test(value)) return "产品";
  return fallback;
}
export const cockpitRadarJobs: Job[] = cockpitRadarCompanies
  .flatMap((company) =>
    cockpitRoleColumns.flatMap((column) =>
      splitCockpitRoles(company[column.key]).map((name, index) => ({
        id: `${company.id}:${column.key}:${index + 1}`,
        name,
        client: company.company,
        industry: company.business || "未标注业务方向",
        city: company.city || "待确认",
        pm: "待后端同步",
        status: "待同步" as const,
        score: null,
        hc: null,
        feedback: "待接入",
        recommended: null,
        interview: null,
        offer: null,
        reason: `驾驶舱导入 · ${column.label}`,
        salary: "待同步",
        source: "驾驶舱导入" as const,
        positionType: classifyCockpitRole(name, column.fallback),
        sourceColumn: column.label,
      })),
    ),
  )
  .filter((job, index, items) => items.findIndex((candidate) => candidate.client === job.client && candidate.name === job.name) === index);
// 离线演示的合并雷达列表；connected 模式在组件内用后端 /api/v1/radar 替代
export const demoRadarJobs: Job[] = [...jobs, ...cockpitRadarJobs];
