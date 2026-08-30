/** 加载技能手册(brainx-* 各领域操作手册;目录已随 system prompt 给出)。 */
import { loadSkill } from '../skills.js';

export default {
  name: 'brainx_load_skill',
  description: '加载指定技能的完整操作手册(brainx-workbench/brainx-engagement/brainx-data-explorer/brainx-talent/brainx-ops/brainx-report 等)。处理对应领域任务前先加载。',
  parameters: { type: 'object', required: ['name'], properties: {
    name: { type: 'string', description: '技能名(见系统提示中的索引)' } } },
  run: ({ name }, ctx) => {
    const skill = loadSkill(ctx.skillsIndex, String(name || ''));
    return skill || { error: 'NOT_FOUND', message: `没有名为 ${name} 的技能,可用技能见系统提示索引` };
  },
};
