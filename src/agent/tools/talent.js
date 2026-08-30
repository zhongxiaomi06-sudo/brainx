/** 人才库查询(MySQL 不可用时自动内存回退;列表/单人/简历三合一)。 */
import { listTalentsWithTags, getTalent, listResumes, talentHealth } from '../../talent.js';

export default {
  name: 'brainx_talent',
  description: '人才库查询:无参=候选人列表(含标签,可按 query 过滤);传 talent_id=单人详情+简历;health=true=后端连通状态。',
  parameters: { type: 'object', properties: {
    talent_id: { type: 'number', description: '人才 ID,给了就查单人+简历' },
    query: { type: 'string', description: '列表按 姓名/摘要 子串过滤' },
    limit: { type: 'number', description: '列表条数,默认 20,上限 100' },
    health: { type: 'boolean', description: 'true 时只查人才库后端健康状态' } } },
  run: async ({ talent_id: id, query, limit = 20, health = false }, ctx) => {
    if (health) return talentHealth();
    if (id != null) {
      const talent = await getTalent(id);
      if (!talent) return { error: 'NOT_FOUND', talent_id: id };
      return { talent, resumes: await listResumes(id) };
    }
    let rows = await listTalentsWithTags({ limit: Math.min(limit, 100) });
    if (query) {
      const q = String(query).toLowerCase();
      rows = rows.filter((r) => `${r.name || ''} ${r.summary || ''}`.toLowerCase().includes(q));
    }
    return { backend: (await talentHealth())?.backend || 'unknown', count: rows.length, items: rows };
  },
};
