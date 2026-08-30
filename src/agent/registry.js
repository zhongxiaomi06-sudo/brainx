/** registry.js — 声明式工具行 → OpenAI tools schema + 分发执行(cordis 风格注册表,零依赖)。
 * 每行 = { name, description, parameters, run(args, ctx) };写操作工具(engage/record_progress/
 * terminal_result/record_outcome/feedback/recommend_run/sync_now)刻意不在此注册——产品内机器人严格只读。 */
import { createHash } from 'node:crypto';
import consultants from './tools/consultants.js';
import workbench from './tools/workbench.js';
import recommendations from './tools/recommendations.js';
import opportunity from './tools/opportunity.js';
import progressSuggestion from './tools/progress-suggestion.js';
import replay from './tools/replay.js';
import profile from './tools/profile.js';
import pushPreview from './tools/push-preview.js';
import radar from './tools/radar.js';
import clients from './tools/clients.js';
import talent from './tools/talent.js';
import talentSupply from './tools/talent-supply.js';
import openmai from './tools/openmai.js';
import querySql from './tools/query-sql.js';
import loadSkillTool from './tools/load-skill.js';

export const TOOL_ROWS = [
  consultants, workbench, recommendations, opportunity, progressSuggestion,
  replay, profile, pushPreview, radar, clients, talent, talentSupply, openmai, querySql, loadSkillTool,
];

const RESULT_CAP = 30000;
const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const stableStringify = (value) => JSON.stringify(value, (key, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
    : v
));

/** 结果序列化并截断(头 26k + 标记 + 尾 3k),防止单条 tool 消息撑爆上下文。 */
const capResult = (result) => {
  const text = JSON.stringify(result) ?? 'null';
  if (text.length <= RESULT_CAP) return text;
  return `${text.slice(0, 26000)}\n…[截断:原文 ${text.length} 字符]…\n${text.slice(-3000)}`;
};

/** ctx = { db, cid, skillsIndex, readDb }。includeSql=false 时 query_sql 不进 schema(BRAINX_AGENT_SQL=0 逃生门)。 */
export function createToolkit(ctx, { includeSql = process.env.BRAINX_AGENT_SQL !== '0' } = {}) {
  const rows = TOOL_ROWS.filter((r) => includeSql || r.name !== 'query_sql');
  const byName = new Map(rows.map((r) => [r.name, r]));
  const schemas = rows.map(({ name, description, parameters }) => ({
    type: 'function', function: { name, description, parameters: parameters || { type: 'object', properties: {} } },
  }));
  const recent = []; // 循环检测:最近 6 次调用签名(工具+参数+结果前 400 字符)

  async function call(name, args) {
    const row = byName.get(name);
    let content;
    if (!row) {
      content = JSON.stringify({ error: 'UNKNOWN_TOOL', message: `未注册的工具:${name},可用工具见 schema 列表` });
    } else if (args?.__parseError) {
      content = JSON.stringify({ error: 'BAD_ARGUMENTS', message: `arguments 不是合法 JSON:${args.__parseError}` });
    } else {
      let result;
      try {
        result = await row.run(args || {}, ctx);
      } catch (e) {
        result = { error: 'TOOL_FAILED', message: String(e?.message || e).slice(0, 300) };
      }
      content = capResult(result);
      // 循环检测:同工具+同参数+同结果出现第 3 次时,在结果尾附中文纠偏提示
      const sig = sha1(name + stableStringify(args || {}));
      const resultSig = sha1(content.slice(0, 400));
      const sameCount = recent.filter((r) => r.sig === sig && r.resultSig === resultSig).length;
      recent.push({ sig, resultSig });
      if (recent.length > 6) recent.shift();
      if (sameCount >= 2) {
        content += '\n\n[系统提示] 你已多次以相同参数调用此工具并得到相同结果。请改变策略:换工具、换参数,或基于已有信息直接回答。';
      }
    }
    return content;
  }

  return { schemas, call, toolCount: rows.length };
}
