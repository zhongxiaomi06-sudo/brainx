import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env','utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2];
}
const mysql = (await import('mysql2/promise')).default;
const c = await mysql.createConnection({
  host: process.env.BRAINX_MYSQL_HOST, port: +process.env.BRAINX_MYSQL_PORT,
  user: process.env.BRAINX_MYSQL_USER, password: process.env.BRAINX_MYSQL_PASSWORD,
  database: process.env.BRAINX_MYSQL_DATABASE });
const [tables] = await c.query('SHOW TABLES');
const key = Object.keys(tables[0])[0];
console.log('== 库内表及行数 ==');
for (const row of tables) { const t = row[key];
  const [[{n}]] = await c.query('SELECT COUNT(*) n FROM `'+t+'`');
  console.log('  '+t+': '+n+' 行'); }
try { await c.query('CREATE TEMPORARY TABLE _probe_w (id INT)');
  await c.query('INSERT INTO _probe_w VALUES (1)');
  const [[{n}]] = await c.query('SELECT COUNT(*) n FROM _probe_w');
  console.log('== 写权限: 临时表插入 '+n+' 行 → 可写 ✅ =='); }
catch(e){ console.log('== 写权限: ❌ '+e.code); }
await c.end();
