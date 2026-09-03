const DEFAULTS = Object.freeze({
  enabled: true,
  times: Object.freeze(['07:00', '19:00']),
  job_count: 3,
  timezone: 'Asia/Shanghai',
});

function parseProfile(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeTimes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const times = [...new Set(value.map((item) => String(item).trim()))].sort();
  if (times.length !== value.length
      || !times.every((item) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item))) return null;
  const minutes = times.map((item) => Number(item.slice(0, 2)) * 60 + Number(item.slice(3)));
  return minutes.every((minute, index) => index === 0 || minute - minutes[index - 1] >= 30)
    ? times : null;
}

export function getPushPreferences(db, consultantId) {
  const row = db.prepare('SELECT profile_json FROM consultants WHERE consultant_id=? AND active=1')
    .get(consultantId);
  if (!row) return null;
  const saved = parseProfile(row.profile_json).push_preferences || {};
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULTS.enabled,
    times: normalizeTimes(saved.times) || [...DEFAULTS.times],
    job_count: Number.isInteger(saved.job_count) && saved.job_count >= 1 && saved.job_count <= 10
      ? saved.job_count : DEFAULTS.job_count,
    timezone: DEFAULTS.timezone,
  };
}

export function updatePushPreferences(db, consultantId, input = {}) {
  const row = db.prepare('SELECT profile_json FROM consultants WHERE consultant_id=? AND active=1')
    .get(consultantId);
  if (!row) return { ok: false, status: 404, error: '顾问不存在' };
  const current = getPushPreferences(db, consultantId);
  const times = input.times === undefined ? current.times : normalizeTimes(input.times);
  const count = input.job_count === undefined ? current.job_count : input.job_count;
  if (!times) return { ok: false, status: 422, error: '每天可设置 1—4 个 HH:mm 推送时间' };
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return { ok: false, status: 422, error: '每次推荐职位数必须为 1—10' };
  }
  const profile = parseProfile(row.profile_json);
  profile.push_preferences = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled,
    times,
    job_count: count,
    timezone: DEFAULTS.timezone,
  };
  db.prepare('UPDATE consultants SET profile_json=? WHERE consultant_id=?')
    .run(JSON.stringify(profile), consultantId);
  return { ok: true, preferences: profile.push_preferences };
}

export const DEFAULT_PUSH_PREFERENCES = DEFAULTS;
