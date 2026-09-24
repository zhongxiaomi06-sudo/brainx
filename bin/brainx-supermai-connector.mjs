#!/usr/bin/env node
/** BrainX SuperMai Connector：从用户电脑主动领任务，只把任务与结果送往 BrainX。 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const VERSION = '1.0.0';
const LOCAL = 'http://127.0.0.1:8910';
const APP_DIR = join(homedir(), 'Library', 'Application Support', 'BrainX');
const CONFIG_PATH = join(APP_DIR, 'supermai-connector.json');
const LAUNCH_AGENT = join(homedir(), 'Library', 'LaunchAgents', 'com.brainx.supermai-connector.plist');
const BUN = '/Applications/Sourcing.app/Contents/Resources/bun/bun';
const SCRIPT = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function validServer(value) {
  const url = new URL(String(value || ''));
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password) throw new Error('BrainX 地址必须是 HTTPS');
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plist() {
  const logPath = join(APP_DIR, 'connector.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.brainx.supermai-connector</string>
<key>ProgramArguments</key><array><string>${xml(BUN)}</string><string>${xml(SCRIPT)}</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>`;
}

async function install() {
  const server = validServer(arg('--server'));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await prompt.question('请输入 BrainX 连接中心显示的一次性配对码：')).trim();
  prompt.close();
  if (!code) throw new Error('没有输入配对码');
  const paired = await fetchJson(`${server}/api/v1/supermai/pair/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: `${hostname()} · SuperMai`, platform: process.platform,
      connector_version: VERSION }),
  });
  writePrivate(CONFIG_PATH, JSON.stringify({ server, device_id: paired.device_id,
    device_token: paired.device_token }, null, 2));
  writePrivate(LAUNCH_AGENT, plist());
  const domain = `gui/${process.getuid()}`;
  spawnSync('launchctl', ['bootout', domain, LAUNCH_AGENT], { stdio: 'ignore' });
  const loaded = spawnSync('launchctl', ['bootstrap', domain, LAUNCH_AGENT], { encoding: 'utf8' });
  if (loaded.status !== 0) throw new Error(`启动连接器失败：${String(loaded.stderr || '').trim()}`);
  spawnSync('launchctl', ['kickstart', '-k', `${domain}/com.brainx.supermai-connector`], { stdio: 'ignore' });
  console.log('配对成功。BrainX 会在 SuperMai 已打开且平台已登录时下发找人任务。');
}

function config() {
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return { server: validServer(parsed.server), device_id: String(parsed.device_id),
    device_token: String(parsed.device_token) };
}

async function localStatus() {
  try {
    const health = await fetchJson(`${LOCAL}/api/v1/health`, {}, 1500);
    const chrome = await fetchJson(`${LOCAL}/api/v1/chrome/status`, {}, 2500);
    return { available: health.ok === true, busy: health.busy === true,
      version: String(health.version || ''), platforms: chrome.platforms || {} };
  } catch {
    return { available: false, busy: false, version: null, platforms: {} };
  }
}

async function report(cfg, payload) {
  return fetchJson(`${cfg.server}/api/v1/supermai/relay/report`, {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.device_token}`,
      'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

async function ensureSourcing() {
  let state = await localStatus();
  if (state.available) return state;
  const child = spawn('open', ['-a', 'Sourcing'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1000);
    state = await localStatus();
    if (state.available) return state;
  }
  throw new Error('SuperMai/Sourcing 未能启动');
}

async function runCommand(cfg, message) {
  try {
    await ensureSourcing();
    await fetchJson(`${LOCAL}/api/v1/chrome/launch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    }, 25_000);
    await report(cfg, { command_id: message.command_id, status: 'completed' });
  } catch (error) {
    await report(cfg, { command_id: message.command_id, status: 'failed', error: error.message }).catch(() => {});
  }
}

async function runTask(cfg, task) {
  try {
    const state = await ensureSourcing();
    if (state.busy) throw new Error('SuperMai 当前正在执行其他任务');
    const started = await fetchJson(`${LOCAL}/api/v1/agent/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'search', mode: 'direct',
        brief: { batch_id: task.task_id, keyword: task.criteria, platforms: task.platforms },
        ingest: task.ingest }),
    }, 25_000);
    await report(cfg, { task_id: task.task_id, status: 'started', local_task_id: started.task_id });
    let heartbeats = 0;
    while (true) {
      await sleep(5000);
      const current = await fetchJson(`${LOCAL}/api/v1/agent/${encodeURIComponent(started.task_id)}/state`, {}, 5000);
      if (['done', 'partial', 'failed', 'cancelled'].includes(current.status)) {
        if (current.status === 'failed') {
          await report(cfg, { task_id: task.task_id, status: 'failed', error: 'SuperMai 本地任务失败' });
        }
        return;
      }
      heartbeats++;
      if (heartbeats % 6 === 0) {
        await report(cfg, { task_id: task.task_id, status: 'heartbeat' });
      }
    }
  } catch (error) {
    await report(cfg, { task_id: task.task_id, status: 'failed', error: error.message }).catch(() => {});
  }
}

async function daemon() {
  const cfg = config();
  let failures = 0;
  while (true) {
    try {
      const local = await localStatus();
      const message = await fetchJson(`${cfg.server}/api/v1/supermai/relay/poll`, {
        method: 'POST', headers: { Authorization: `Bearer ${cfg.device_token}`,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ connector_version: VERSION, local }),
      }, 20_000);
      failures = 0;
      if (message.kind === 'command') await runCommand(cfg, message);
      else if (message.kind === 'sourcing_task') await runTask(cfg, message);
      else await sleep(Number(message.retry_after_ms || 5000));
    } catch (error) {
      if (error.status === 401) throw new Error('设备授权已撤销，请从 BrainX 连接中心重新配对');
      failures++;
      console.error(`[connector] 连接暂时失败（第 ${failures} 次）：${error.message}`);
      await sleep(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)));
    }
  }
}

const command = process.argv[2];
try {
  if (command === 'install') await install();
  else if (command === 'run') await daemon();
  else throw new Error('用法：connector.mjs install --server https://brainx.example 或 connector.mjs run');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
