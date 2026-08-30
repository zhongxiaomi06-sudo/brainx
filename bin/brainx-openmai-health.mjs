#!/usr/bin/env node
/** openmai-health.mjs — OpenMai/TTC 凭证晨检（2026-08-30，会议前健康检查）。
 * 对花名册逐人验证：托管 JWT 有效性（getValidTtcJwt）→ TTC quota 活验证
 * （一次 /user/quota 调用）→ OpenMai 可达性（不发起找人，仅打 completions 探针）。
 * 只读，不写库。退出码：全过 0；任一失败 1（供 launchd/晨检告警）。
 * 用法：node bin/brainx-openmai-health.mjs [--db <path>] [--json]
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { loadConsultants } from '../src/recommend.js';
import { getValidTtcJwt, ttcAuthStatus } from '../src/ttcsdk/auth.js';
import { quota } from '../src/ttcsdk/user.js';
import { TtcApiError } from '../src/ttcsdk/http.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };

export async function healthCheck(db, { openmaiProbe = true } = {}) {
  const consultants = loadConsultants(db);
  const rows = [];
  for (const c of consultants) {
    const row = { consultant_id: c.consultant_id, display_name: c.display_name };
    const jwt = getValidTtcJwt(db, c.consultant_id);
    row.jwt = jwt ? 'ok' : 'missing';
    if (jwt) {
      try {
        const q = await quota(jwt);
        row.quota = 'ok';
        row.quota_detail = q && typeof q === 'object' ? q : undefined;
      } catch (e) {
        row.quota = e instanceof TtcApiError && e.authInvalid ? 'auth_invalid' : `error:${String(e.message).slice(0, 60)}`;
      }
    }
    rows.push(row);
  }
  let openmai = 'skipped';
  if (openmaiProbe) {
    // OpenMai 网关可达性探针：只打错误请求验证 401/400 语义（不打真任务，零费用）
    const anyJwt = rows.length ? getValidTtcJwt(db, rows[0].consultant_id) : null;
    if (!anyJwt) openmai = 'no_jwt';
    else {
      const base = (process.env.BRAINX_OPENMAI_BASE || 'https://gateway.ttcadvisory.com').replace(/\/$/, '');
      try {
        const resp = await fetch(`${base}/api/openmai/v1/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${anyJwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'ping', job_id: 'health-check' }),
          signal: AbortSignal.timeout(10000),
        });
        // 2xx=可达且流式开始（立即中断）；4xx=可达但参数/鉴权语义正常返回
        openmai = resp.status < 500 ? `reachable(${resp.status})` : `gateway_error(${resp.status})`;
        resp.body?.cancel?.().catch(() => {});
      } catch (e) { openmai = `unreachable:${String(e.message).slice(0, 60)}`; }
    }
  }
  const failures = rows.filter((r) => r.jwt !== 'ok' || r.quota !== 'ok');
  return { ok: failures.length === 0 && !String(openmai).startsWith('unreachable') && !String(openmai).startsWith('gateway_error'),
           openmai, consultants: rows, failures, checked_at: new Date().toISOString() };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = openDb(arg('db', undefined));
  const out = await healthCheck(db, { openmaiProbe: !process.argv.includes('--no-probe') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    for (const r of out.consultants) {
      console.log(`${r.jwt === 'ok' && r.quota === 'ok' ? '✓' : '✗'} ${r.display_name || r.consultant_id}: jwt=${r.jwt} quota=${r.quota || '-'}`);
    }
    console.log(`openmai 网关: ${out.openmai}`);
    console.log(out.ok ? '晨检通过' : `晨检失败（${out.failures.length} 人凭据异常）`);
  }
  process.exit(out.ok ? 0 : 1);
}
