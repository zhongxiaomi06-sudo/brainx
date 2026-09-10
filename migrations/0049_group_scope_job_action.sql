-- 0049: 项目群 scope 补齐接单用途（specs/014）。
-- 存量项目群只放行看人/候选动作，群内接单被 NOT_FOUND_OR_FORBIDDEN 拦死；
-- 幂等追加 job_action（已含则跳过），保留原有 purposes 原样。
UPDATE agent_group_scopes
SET allowed_purposes_json = json_insert(allowed_purposes_json, '$[#]', 'job_action')
WHERE scope_status = 'ACTIVE'
  AND json_valid(allowed_purposes_json)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agent_group_scopes.allowed_purposes_json)
    WHERE json_each.value = 'job_action'
  );
