/** SuperMai 云端 relay 账本：设备配对、出站轮询、任务租约与候选人定稿。 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { now, uuid } from './db.js';

const PLATFORMS = new Set(['boss', 'maimai', 'liepin']);
const FINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const ONLINE_MS = 90_000;

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const short = (value, max) => String(value ?? '').trim().slice(0, max);
const jsonObject = (value) => {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function cleanPlatforms(value, fallback = ['boss', 'maimai', 'liepin']) {
  if (!Array.isArray(value)) return fallback;
  const items = [...new Set(value.map(String).filter((item) => PLATFORMS.has(item)))];
  return items.length ? items : fallback;
}

function event(db, taskId, type, payload = {}) {
  db.prepare(`INSERT INTO sourcing_task_events (task_id,event_type,payload_json,created_at)
    VALUES (?,?,?,?)`).run(taskId, type, JSON.stringify(payload), now());
}

export function createSupermaiPairCode(db, consultantId, { ttlMs = 10 * 60_000 } = {}) {
  const raw = randomBytes(8).toString('hex').toUpperCase();
  const code = raw.match(/.{1,4}/g).join('-');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('DELETE FROM supermai_pair_codes WHERE consultant_id=? OR expires_at<=?')
    .run(consultantId, createdAt);
  db.prepare(`INSERT INTO supermai_pair_codes
    (code_hash,consultant_id,expires_at,created_at) VALUES (?,?,?,?)`)
    .run(digest(code), consultantId, expiresAt, createdAt);
  return { code, expires_at: expiresAt };
}

export function claimSupermaiPairCode(db, input = {}) {
  const code = short(input.code, 32).toUpperCase();
  const at = now();
  const row = db.prepare(`SELECT code_hash,consultant_id,expires_at,used_at
    FROM supermai_pair_codes WHERE code_hash=?`).get(digest(code));
  if (!row || row.used_at || row.expires_at <= at) return null;
  const token = randomBytes(32).toString('base64url');
  const deviceId = `smd_${uuid()}`;
  const name = short(input.name, 80) || 'SuperMai Desktop';
  const platform = short(input.platform, 40) || 'unknown';
  db.exec('BEGIN');
  try {
    const used = db.prepare(`UPDATE supermai_pair_codes SET used_at=?
      WHERE code_hash=? AND used_at IS NULL AND expires_at>?`).run(at, row.code_hash, at).changes;
    if (!used) { db.exec('ROLLBACK'); return null; }
    db.prepare(`INSERT INTO supermai_devices
      (device_id,consultant_id,name,platform,connector_version,token_hash,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(deviceId, row.consultant_id, name, platform,
      short(input.connector_version, 40) || null, digest(token), at);
    db.prepare(`UPDATE sourcing_tasks SET status='queued',updated_at=?
      WHERE consultant_id=? AND provider='supermai' AND status='waiting_for_device'`)
      .run(at, row.consultant_id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { device_id: deviceId, device_token: token, consultant_id: row.consultant_id };
}

export function authenticateSupermaiDevice(db, authorization) {
  const raw = String(authorization || '');
  if (!raw.startsWith('Bearer ')) return null;
  const tokenHash = digest(raw.slice(7).trim());
  const row = db.prepare(`SELECT * FROM supermai_devices
    WHERE token_hash=? AND revoked_at IS NULL`).get(tokenHash);
  return row && safeEqualHex(row.token_hash, tokenHash) ? row : null;
}

export function revokeSupermaiDevice(db, consultantId, deviceId) {
  const at = now();
  return db.prepare(`UPDATE supermai_devices SET revoked_at=?
    WHERE device_id=? AND consultant_id=? AND revoked_at IS NULL`).run(at, deviceId, consultantId).changes > 0;
}

export function supermaiDeviceStatus(db, consultantId, atMs = Date.now()) {
  const rows = db.prepare(`SELECT device_id,name,platform,connector_version,state_json,last_seen_at
    FROM supermai_devices WHERE consultant_id=? AND revoked_at IS NULL
    ORDER BY COALESCE(last_seen_at,created_at) DESC`).all(consultantId);
  const devices = rows.map((row) => {
    const state = jsonObject(row.state_json);
    const online = Boolean(row.last_seen_at) && atMs - Date.parse(row.last_seen_at) <= ONLINE_MS;
    return {
      device_id: row.device_id, name: row.name, platform: row.platform,
      connector_version: row.connector_version || null, online,
      last_seen_at: row.last_seen_at || null,
      desktop_available: online && state.available === true,
      desktop_busy: state.busy === true,
      version: short(state.version, 80) || null,
      platforms: state.platforms && typeof state.platforms === 'object' ? state.platforms : {},
    };
  });
  const active = devices.find((item) => item.online) || null;
  return { registered: devices.length > 0, online: Boolean(active), active, devices };
}

export function queueSupermaiLogin(db, consultantId, platform) {
  if (!PLATFORMS.has(platform)) return null;
  const device = supermaiDeviceStatus(db, consultantId).active;
  if (!device) return { error_code: 'SUPERMAI_DEVICE_OFFLINE' };
  const commandId = `smc_${uuid()}`;
  const at = now();
  db.prepare(`INSERT INTO supermai_commands
    (command_id,consultant_id,device_id,command,payload_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'queued',?,?)`).run(commandId, consultantId, device.device_id,
    'open_login', JSON.stringify({ platform }), at, at);
  return { command_id: commandId, platform };
}

function chooseTaskPlatforms(task, local) {
  const requested = cleanPlatforms(JSON.parse(task.platforms_json || '[]'));
  const states = local?.platforms && typeof local.platforms === 'object' ? local.platforms : {};
  return requested.filter((platform) => states[platform]?.logged_in === true);
}

export function pollSupermaiRelay(db, device, input = {}, { leaseMs = 30 * 60_000 } = {}) {
  const at = now();
  const local = input.local && typeof input.local === 'object' ? input.local : {};
  const publicState = {
    available: local.available === true, busy: local.busy === true,
    version: short(local.version, 80) || null,
    platforms: Object.fromEntries([...PLATFORMS].map((platform) => [platform, {
      running: local.platforms?.[platform]?.running === true,
      logged_in: local.platforms?.[platform]?.logged_in === true ? true
        : local.platforms?.[platform]?.logged_in === false ? false : null,
    }])),
  };
  db.prepare(`UPDATE supermai_devices SET connector_version=?,state_json=?,last_seen_at=?
    WHERE device_id=?`).run(short(input.connector_version, 40) || device.connector_version,
    JSON.stringify(publicState), at, device.device_id);
  db.prepare(`UPDATE sourcing_tasks SET status='queued',device_id=NULL,lease_expires_at=NULL,
    ingest_token_hash=NULL,updated_at=? WHERE consultant_id=? AND provider='supermai'
    AND status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`)
    .run(at, device.consultant_id, at);

  const command = db.prepare(`SELECT * FROM supermai_commands WHERE consultant_id=?
    AND status='queued' AND (device_id IS NULL OR device_id=?) ORDER BY created_at LIMIT 1`)
    .get(device.consultant_id, device.device_id);
  if (command) {
    const claimed = db.prepare(`UPDATE supermai_commands SET status='running',device_id=?,updated_at=?
      WHERE command_id=? AND status='queued'`).run(device.device_id, at, command.command_id).changes;
    if (claimed) return { kind: 'command', command_id: command.command_id,
      command: command.command, payload: jsonObject(command.payload_json) };
  }

  if (!publicState.available || publicState.busy) return { kind: 'idle', retry_after_ms: 5000 };
  const candidates = db.prepare(`SELECT * FROM sourcing_tasks WHERE consultant_id=?
    AND provider='supermai' AND status IN ('queued','waiting_for_device')
    ORDER BY created_at LIMIT 10`).all(device.consultant_id);
  const task = candidates.find((item) => chooseTaskPlatforms(item, publicState).length > 0);
  if (!task) return { kind: 'idle', retry_after_ms: 5000 };
  const platforms = chooseTaskPlatforms(task, publicState);
  const ingestToken = randomBytes(32).toString('base64url');
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  const claimed = db.prepare(`UPDATE sourcing_tasks SET status='running',device_id=?,
    platforms_json=?,lease_expires_at=?,ingest_token_hash=?,started_at=COALESCE(started_at,?),updated_at=?
    WHERE task_id=? AND status IN ('queued','waiting_for_device')`).run(
    device.device_id, JSON.stringify(platforms), leaseExpiresAt, digest(ingestToken), at, at, task.task_id,
  ).changes;
  if (!claimed) return { kind: 'idle', retry_after_ms: 1000 };
  event(db, task.task_id, 'claimed', { device_id: device.device_id, platforms });
  return { kind: 'sourcing_task', task_id: task.task_id, criteria: task.criteria,
    platforms, ingest_token: ingestToken, lease_expires_at: leaseExpiresAt };
}

function taskByIngestToken(db, taskId, token) {
  const task = db.prepare('SELECT * FROM sourcing_tasks WHERE task_id=?').get(taskId);
  return task && safeEqualHex(task.ingest_token_hash, digest(token)) ? task : null;
}

const PROFILE_HOSTS = {
  boss: ['zhipin.com'], maimai: ['maimai.cn'], liepin: ['liepin.com'],
};

function safeProfileUrl(value, platform) {
  try {
    const url = new URL(String(value || ''));
    const allowed = PROFILE_HOSTS[platform] || [];
    const trusted = allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === 'https:' && trusted ? url.href.slice(0, 1000) : undefined;
  } catch { return undefined; }
}

function normalizeResult(item, platform) {
  const externalId = short(item?.external_id, 180);
  if (!externalId) return null;
  const result = {
    platform, external_id: externalId, name: short(item?.name, 80) || '姓名待核实',
    company: short(item?.company, 160) || undefined,
    title: short(item?.title, 160) || undefined,
    city: short(item?.city, 80) || undefined,
    years: Number.isFinite(item?.years) ? Math.max(0, Math.min(80, item.years)) : undefined,
    edu_school: short(item?.edu_school, 160) || undefined,
    edu_degree: short(item?.edu_degree, 80) || undefined,
    profile_url: safeProfileUrl(item?.profile_url, platform),
    skills: Array.isArray(item?.skills) ? item.skills.slice(0, 30).map((x) => short(x, 80)).filter(Boolean) : undefined,
    tags: Array.isArray(item?.tags) ? item.tags.slice(0, 30).map((x) => short(x, 80)).filter(Boolean) : undefined,
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

export function ingestSupermaiResults(db, taskId, token, input = {}) {
  const task = taskByIngestToken(db, taskId, token);
  if (!task || task.status !== 'running' || !task.lease_expires_at
      || task.lease_expires_at <= now()) return null;
  const platform = short(input.platform, 20);
  if (!PLATFORMS.has(platform) || !Array.isArray(input.items) || input.items.length > 100) return false;
  const at = now();
  const insert = db.prepare(`INSERT OR IGNORE INTO sourcing_results
    (task_id,platform,external_id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`);
  let accepted = 0;
  let deduped = 0;
  db.exec('BEGIN');
  try {
    for (const raw of input.items) {
      const item = normalizeResult(raw, platform);
      if (!item) continue;
      const changes = insert.run(taskId, platform, item.external_id, JSON.stringify(item), at, at).changes;
      accepted += changes;
      deduped += changes ? 0 : 1;
    }
    db.prepare('UPDATE sourcing_tasks SET updated_at=? WHERE task_id=?').run(at, taskId);
    db.prepare(`UPDATE sourcing_tasks SET lease_expires_at=? WHERE task_id=? AND status='running'`)
      .run(new Date(Date.now() + 30 * 60_000).toISOString(), taskId);
    event(db, taskId, 'ingest', { platform, accepted, deduped, round: Number(input.round || 0) });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { accepted, deduped, statuses: {} };
}

function candidateRef(item) {
  const raw = `${item.platform}:${item.external_id}`.replace(/[^A-Za-z0-9:_-]/g, '_');
  return raw.length <= 100 ? raw : `${item.platform}:${digest(item.external_id).slice(0, 32)}`;
}

export function buildSupermaiResultText(rows) {
  const items = rows.slice(0, 10).map((row) => jsonObject(row.payload_json));
  if (!items.length) return 'NO_REPLY';
  const lines = items.map((item, index) => {
    const role = [item.company, item.title].filter(Boolean).join(' / ') || '当前岗位待核实';
    return `${index + 1}. ${item.name}｜${role}｜${item.city || '城市待核实'}｜来源 ${item.platform}`;
  });
  const candidates = items.map((item) => ({
    candidate_ref: candidateRef(item), name: item.name,
    source: item.platform,
    role: [item.company, item.title].filter(Boolean).join(' / ') || '当前岗位待核实',
    experience: Number.isFinite(item.years) ? `${item.years} 年` : '待核实',
    city: item.city || '待核实',
    education: [item.edu_degree, item.edu_school].filter(Boolean).join(' / ') || '待核实',
    evaluation: [...(item.skills || []), ...(item.tags || [])].slice(0, 5).join('、') || '请顾问结合职位要求核验',
    score: '待评估', talent_url: null, profile_url: item.profile_url || null,
  }));
  return `${lines.join('\n')}\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates })}\n-->`;
}

export function finishSupermaiTask(db, taskId, token, input = {}) {
  const task = taskByIngestToken(db, taskId, token);
  if (!task) return null;
  if (FINAL.has(task.status)) {
    return { status: task.status, result_count: db.prepare(
      'SELECT COUNT(*) count FROM sourcing_results WHERE task_id=?').get(taskId).count };
  }
  if (task.status !== 'running') return false;
  if (!task.lease_expires_at || task.lease_expires_at <= now()) return null;
  const requested = short(input.status, 20);
  if (!['done', 'partial', 'failed', 'cancelled'].includes(requested)) return false;
  const rows = db.prepare(`SELECT payload_json FROM sourcing_results
    WHERE task_id=? ORDER BY created_at,platform,external_id`).all(taskId);
  const resultText = buildSupermaiResultText(rows);
  const finalStatus = requested === 'done' ? 'completed' : requested;
  const openmaiStatus = ['completed', 'partial'].includes(finalStatus) ? 'done' : 'failed';
  const at = now();
  const error = openmaiStatus === 'failed'
    ? short(input.errors?.map?.((item) => item?.message || item).join('；'), 500) || `SuperMai ${finalStatus}` : null;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE sourcing_tasks SET status=?,finished_at=?,updated_at=?,error_code=?,error_message=?
      WHERE task_id=? AND status='running'`).run(finalStatus, at, at,
      openmaiStatus === 'failed' ? 'SUPERMAI_SEARCH_FAILED' : null, error, taskId);
    db.prepare(`UPDATE openmai_results SET status=?,result_text=?,error=?,finished_at=?
      WHERE consultant_id=? AND task_id=?`).run(openmaiStatus,
      openmaiStatus === 'done' ? resultText : null, error, at,
      task.consultant_id, taskId);
    event(db, taskId, 'finished', { status: finalStatus, result_count: rows.length,
      platform_counts: input.platform_counts || {} });
    db.exec('COMMIT');
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  return { status: finalStatus, result_count: rows.length };
}

export function reportSupermaiRelay(db, device, input = {}) {
  const at = now();
  if (input.command_id) {
    const status = input.status === 'completed' ? 'completed' : 'failed';
    const changed = db.prepare(`UPDATE supermai_commands SET status=?,finished_at=?,updated_at=?,error_message=?
      WHERE command_id=? AND consultant_id=? AND device_id=? AND status='running'`).run(
      status, at, at, status === 'failed' ? short(input.error, 500) : null,
      short(input.command_id, 80), device.consultant_id, device.device_id,
    ).changes;
    return changed ? { ok: true } : null;
  }
  const taskId = short(input.task_id, 80);
  const task = db.prepare(`SELECT * FROM sourcing_tasks WHERE task_id=? AND consultant_id=?
    AND device_id=?`).get(taskId, device.consultant_id, device.device_id);
  if (!task) return null;
  if (input.status === 'started') {
    event(db, taskId, 'desktop_started', { local_task_id: short(input.local_task_id, 100) });
    return { ok: true };
  }
  if (input.status === 'heartbeat' && task.status === 'running') {
    db.prepare(`UPDATE sourcing_tasks SET lease_expires_at=?,updated_at=? WHERE task_id=?`)
      .run(new Date(Date.now() + 30 * 60_000).toISOString(), at, taskId);
    return { ok: true };
  }
  if (input.status !== 'failed' || FINAL.has(task.status)) return { ok: true };
  const message = short(input.error, 500) || '桌面连接器启动任务失败';
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE sourcing_tasks SET status='failed',error_code='SUPERMAI_DESKTOP_FAILED',
      error_message=?,finished_at=?,updated_at=? WHERE task_id=? AND status='running'`)
      .run(message, at, at, taskId);
    db.prepare(`UPDATE openmai_results SET status='failed',error=?,finished_at=?
      WHERE task_id=? AND status='running'`).run(message, at, taskId);
    event(db, taskId, 'failed', { error_code: 'SUPERMAI_DESKTOP_FAILED' });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ok: true };
}
