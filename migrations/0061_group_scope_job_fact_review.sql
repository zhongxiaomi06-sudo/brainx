-- 0061: 项目群 scope 补齐建岗用途 job_fact_review（2026-10-09 群建岗接线）。
-- 群贴 JD 建岗的引擎/handler 早已就绪（specs/005 群内扩展 + 群内一步转正测试在案），
-- 但群授权范围不含 job_fact_review，brainx_submit_job_jd 在所有群场景被
-- authorizeGroup 拒绝——绑定卡「直接贴 JD 建岗」的承诺因此落空。
-- GROUP_PURPOSES（src/project-launch.js）已同步补齐，此处按 0049 同法回填存量 ACTIVE 群。
UPDATE agent_group_scopes
SET allowed_purposes_json = json_insert(allowed_purposes_json, '$[#]', 'job_fact_review')
WHERE scope_status = 'ACTIVE'
  AND json_valid(allowed_purposes_json)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(agent_group_scopes.allowed_purposes_json)
    WHERE json_each.value = 'job_fact_review'
  );
