/** fixture_split.js — fixture 源公司/职能拆分（方案 C 治本）。
 * fixture 是 Felix 策展导出，存在两种合并脏数据：
 *   1) company="雨林时代/sigmaz/科漫"（多公司塞一字段）
 *   2) role="产品、工程、运营增长（多岗）"（多职能塞一字段）
 * 在 runSync 入库前展开成「公司 × 单职能」多行，复用 bitable.js 的 deriveProjectId
 * 重算 project_id，与 Bitable 源同一展开纪律。
 * 对已规范的单行（无 '/' 公司、无 '、' 职能）是 no-op，故对 bridge/ttc 源安全。 */
import { deriveProjectId } from './bitable.js';

const MULTI_ROLE_SUFFIX = /（多岗）|\(多岗\)/g;

/** 拆分 company：仅当含 '/' 且 '/' 两侧无空格时按 '/' 拆（避免误伤 "A / B" 公司名）。 */
function splitCompanies(company) {
  if (!company || typeof company !== 'string') return [company];
  if (!company.includes('/')) return [company];
  if (/\s\/\s/.test(company)) return [company]; // "Wanderboat AI / Uta AI" 保留
  const parts = company.split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [company];
}

/** 拆分 role：去掉"（多岗）"后缀；含顿号则按顿号拆成单职能。role 内的 '/' 保留（同类目）。 */
function splitRoles(role) {
  if (!role || typeof role !== 'string') return [role];
  const cleaned = role.replace(MULTI_ROLE_SUFFIX, '').trim();
  if (!cleaned) return [role];
  if (!cleaned.includes('、')) return [cleaned];
  const parts = cleaned.split('、').map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [cleaned];
}

/** 把一条 fixture job 展开成 1..n 条单公司×单职能行。 */
export function splitFixtureJob(job) {
  if (!job || !job.company) return job ? [job] : [];
  const companies = splitCompanies(job.company);
  const roles = splitRoles(job.role);
  const out = [];
  for (const company of companies) {
    for (const role of roles) {
      out.push({ ...job, company, role, project_id: deriveProjectId(company, role) });
    }
  }
  return out;
}
