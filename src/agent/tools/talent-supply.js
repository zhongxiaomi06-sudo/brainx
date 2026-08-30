/** 职位人才供给快照(只读 match_record,不重算不写库;需 BRAINX_TALENT_SUPPLY=1)。 */
import { talentSupplyEnabled, readTalentSupply } from '../../talent-supply.js';
import { jobVisibleTo } from '../../visibility.js';

export default {
  name: 'brainx_talent_supply',
  description: '某职位的人才供给快照:可匹配候选人数/供给难度/Top 匹配及命中词。只读旁路,不参与推荐评分。未开启或未见记录时如实返回。',
  parameters: { type: 'object', required: ['project_id'], properties: {
    project_id: { type: 'string' } } },
  run: async ({ project_id: pid }, ctx) => {
    if (!talentSupplyEnabled()) return { error: 'SUPPLY_DISABLED', message: '人才供给功能未开启(BRAINX_TALENT_SUPPLY)' };
    if (!jobVisibleTo(ctx.db, ctx.cid, pid)) return { error: 'NOT_FOUND', project_id: pid };
    const job = ctx.db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(pid);
    if (!job) return { error: 'NOT_FOUND', project_id: pid };
    const supply = await readTalentSupply(job);
    return supply || { empty: true, message: '该职位尚无供给匹配记录(需先由系统跑过供给计算)' };
  },
};
