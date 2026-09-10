import { bindCurrentGroupProject } from '../group-intake.js';

export function createGroupBindingToolHandlers({ db, ...dependencies } = {}) {
  return {
    brainx_bind_group_project: async (args, context) => {
      const result = await bindCurrentGroupProject(db, context.principal, args.job_id, dependencies);
      return {
        data: result,
        facts: [{ job_ref: args.job_id, current_group_bound: true }],
        inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`job_fact:${args.job_id}`],
        next_allowed_actions: ['brainx_accept_job', 'brainx_openmai_search', 'brainx_supermai_scout'],
      };
    },
  };
}
