#!/usr/bin/env node
import '../src/env.js';
import { initTalentSchema, withMysql, mysqlLocalDatetime } from '../src/db.js';
import { writeStructuredCandidateFacts } from '../src/talent-pipeline/facts.js';
import { runCursorSync } from '../src/talent-pipeline/sync-cursor.js';

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const tenantId = required('BRAINX_TENANT_ID');
const consultantId = required('BRAINX_RELOOP_CONSULTANT_ID');
const sourceAccountRef = required('BRAINX_RELOOP_SOURCE_OWNER_ID');
const expectedBoundName = required('BRAINX_RELOOP_EXPECTED_BOUND_NAME');
const pageSize = Number(process.env.BRAINX_RELOOP_PAGE_SIZE || 100);

await initTalentSchema();
const summary = await withMysql(async (conn) => {
  const [[owner]] = await conn.execute(
    'SELECT user_id, ttc_bound_name FROM reloop_app.users WHERE user_id=? LIMIT 1',
    [sourceAccountRef],
  );
  if (!owner || String(owner.ttc_bound_name || '').trim() !== expectedBoundName) {
    throw new Error('SOURCE_ACCOUNT_BINDING_MISMATCH');
  }
  const [[cursorRow]] = await conn.execute(
    `SELECT cursor_value FROM source_sync_cursors
     WHERE tenant_id=? AND source_system='reloop_app' AND source_account_ref=? AND cursor_kind='talent_profiles_v1'`,
    [tenantId, sourceAccountRef],
  );
  const initialCursor = cursorRow?.cursor_value || null;
  return runCursorSync({
    initialCursor, pageSize,
    fetchPage: async ({ cursor, limit }) => {
      let updatedAt = '1970-01-01T00:00:00.000Z';
      let id = 0;
      if (cursor) ({ updatedAt, id } = JSON.parse(cursor));
      const [items] = await conn.execute(
        `SELECT id, name, base_location, company, position, work_years, education,
                skills, value_score, last_active_at, tags, source_payload,
                work_history, education_history, expected_salary, updated_at
         FROM reloop_app.talent_profiles
         WHERE owner_user_id=? AND (updated_at > ? OR (updated_at = ? AND id > ?))
         ORDER BY updated_at ASC, id ASC LIMIT ${limit + 1}`,
        [sourceAccountRef, updatedAt, updatedAt, id],
      );
      const page = items.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page,
        nextCursor: last ? JSON.stringify({ updatedAt: mysqlLocalDatetime(last.updated_at), id: Number(last.id) }) : cursor,
        hasMore: items.length > limit,
      };
    },
    writePage: async (profiles) => {
      await conn.beginTransaction();
      try {
        await writeStructuredCandidateFacts(conn, {
          tenantId, consultantId, sourceAccountRef, profiles,
          sourceProofRef: `reloop_app.users:${sourceAccountRef}:ttc_bound_name`,
        });
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    },
    saveCursor: async (cursor) => conn.execute(
      `INSERT INTO source_sync_cursors
         (tenant_id, source_system, source_account_ref, cursor_kind, cursor_value, updated_at)
       VALUES (?, 'reloop_app', ?, 'talent_profiles_v1', ?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE cursor_value=VALUES(cursor_value), updated_at=VALUES(updated_at)`,
      [tenantId, sourceAccountRef, cursor || ''],
    ),
  });
});

process.stdout.write(`${JSON.stringify(summary)}\n`);
