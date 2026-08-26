/** TTC 职位字段库：外部字段语义、BrainX 映射、主表展示与筛选能力的单一权威。 */

export const TTC_FIELD_SCHEMA_VERSION = 'ttc-job-search-2026-08-26';

export const TTC_FIELD_CATALOG = Object.freeze([
  { key: 'role', label: '职位', source: 'name', kind: 'text', required: true,
    main_column: true, filter: 'search', meaning: 'TTC 职位名称' },
  { key: 'company', label: '公司', source: 'company_name / company_name_for_c', kind: 'text', required: true,
    main_column: true, filter: 'multi', meaning: '按 TTC 脱敏规则得到的公司名称' },
  { key: 'city', label: '城市', source: 'cities[]', kind: 'text-list', required: false,
    main_column: true, filter: 'multi', meaning: '职位工作城市；多城市必须拆项筛选' },
  { key: 'active_state', label: 'TTC 状态', source: 'status', kind: 'enum', required: true,
    main_column: true, filter: 'enum', meaning: '1=活跃，0=冷却，其余=待确认' },
  { key: 'hc', label: 'HC', source: 'head_count', kind: 'integer', required: false,
    main_column: true, filter: 'number-range', meaning: 'TTC 当前职位 HC' },
  { key: 'pipeline', label: 'Pipeline 进展', source: 'pipeline_info.pipeline_step_count', kind: 'stage-counts', required: false,
    main_column: true, filter: 'stage-count', meaning: 'Sourcing、推荐、面试、Offer 等阶段人数' },
  { key: 'owner_name', label: '主做顾问', source: 'managers[0].name', kind: 'text', required: false,
    main_column: true, filter: 'multi', meaning: 'TTC 第一位负责人' },
  { key: 'captured_at', label: '最近更新', source: 'update_time', kind: 'datetime', required: false,
    main_column: true, filter: 'date-range', meaning: 'TTC 职位事实最后更新时间' },
  { key: 'notes', label: '职位描述', source: 'analytics / description', kind: 'long-text', required: false,
    main_column: false, filter: 'search', meaning: '用于详情搜索和后续结构化分类，不直接作为枚举筛选' },
  { key: 'project_id', label: 'TTC 职位 ID', source: 'unique_id', kind: 'identifier', required: true,
    main_column: false, filter: null, meaning: 'TTC 权威职位主键' },
]);

export const TTC_MAIN_COLUMNS = Object.freeze(
  TTC_FIELD_CATALOG.filter((field) => field.main_column).map((field) => field.key),
);

const present = (value) => value !== null && value !== undefined && value !== '';

/** 检查一条 TTC 原始职位是否符合当前已验证形状；错误阻断，警告只降级字段能力。 */
export function inspectTtcJob(job) {
  const errors = [];
  const warnings = [];
  if (!job || typeof job !== 'object') return { ok: false, errors: ['职位记录不是对象'], warnings };
  if (!String(job.unique_id || '').trim()) errors.push('缺 unique_id');
  if (!String(job.name || '').trim()) errors.push('缺 name');
  const blurred = job.need_blur === 1 || job.need_blur === true;
  const company = blurred ? job.company_name_for_c : job.company_name;
  if (!String(company || '').trim()) errors.push(blurred ? '脱敏职位缺 company_name_for_c' : '缺 company_name');
  if (job.cities != null && !Array.isArray(job.cities)) warnings.push('cities 不是数组');
  if (job.head_count != null && (!Number.isFinite(Number(job.head_count)) || Number(job.head_count) < 0)) {
    warnings.push('head_count 不是非负数');
  }
  if (job.status != null && ![0, 1].includes(Number(job.status))) warnings.push('status 不在已知枚举 0/1');
  if (job.update_time != null && !Number.isFinite(Number(job.update_time))) warnings.push('update_time 不是毫秒时间戳');
  const steps = job.pipeline_info?.pipeline_step_count;
  if (steps != null && (typeof steps !== 'object' || Array.isArray(steps))) warnings.push('pipeline_step_count 不是对象');
  return { ok: errors.length === 0, errors, warnings };
}

/** 从标准化 job_facts 行生成前端可用字段能力；不满足覆盖门槛时仍可展示，但不开放筛选。 */
export function profileTtcFields(rows = [], { filterCoverage = 0.9 } = {}) {
  const total = rows.length;
  return {
    schema_version: TTC_FIELD_SCHEMA_VERSION,
    total_rows: total,
    main_columns: [...TTC_MAIN_COLUMNS],
    fields: TTC_FIELD_CATALOG.map((field) => {
      const populated = rows.reduce((count, row) => count + (present(row?.[field.key]) ? 1 : 0), 0);
      const coverage = total ? populated / total : 0;
      return {
        ...field,
        populated,
        coverage: Math.round(coverage * 1000) / 1000,
        display_available: field.required ? populated === total && total > 0 : populated > 0,
        filter_available: !!field.filter && coverage >= filterCoverage,
      };
    }),
  };
}
