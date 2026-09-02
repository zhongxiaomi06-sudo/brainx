/** Filename-accounted, additive migration runner for the talent RDS. */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TALENT_MIGRATIONS_DIR = join(ROOT, 'talent-migrations');

const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS \`talent_schema_migrations\` (
  \`name\` varchar(255) NOT NULL,
  \`checksum\` char(64) NOT NULL,
  \`applied_at\` datetime(3) NOT NULL,
  PRIMARY KEY (\`name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='人才库迁移历史'`;

const checksum = (statements) => createHash('sha256')
  .update(JSON.stringify(statements)).digest('hex');

/**
 * MySQL DDL implicitly commits. Every migration therefore uses additive,
 * idempotent statements and records its checksum only after all statements pass.
 */
export async function applyTalentMigrations(conn, migrationDir = TALENT_MIGRATIONS_DIR) {
  await conn.execute(HISTORY_DDL);
  const [rows] = await conn.execute('SELECT name, checksum FROM talent_schema_migrations ORDER BY name');
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  const files = readdirSync(migrationDir).filter((name) => /^\d+_.+\.mjs$/.test(name)).sort();
  const result = { discovered: files, applied: [] };

  for (const name of files) {
    const module = await import(pathToFileURL(join(migrationDir, name)).href);
    if (!Array.isArray(module.statements) || module.statements.length === 0
      || module.statements.some((statement) => typeof statement !== 'string' || !statement.trim())) {
      throw new Error(`invalid talent migration: ${name}`);
    }
    const digest = checksum(module.statements);
    const previous = applied.get(name);
    if (applied.has(name)) {
      if (previous && previous !== digest) throw new Error(`talent migration checksum changed: ${name}`);
      continue;
    }
    for (const statement of module.statements) await conn.execute(statement);
    await conn.execute(
      'INSERT INTO talent_schema_migrations (name, checksum, applied_at) VALUES (?, ?, UTC_TIMESTAMP(3))',
      [name, digest],
    );
    result.applied.push(name);
  }
  return result;
}
