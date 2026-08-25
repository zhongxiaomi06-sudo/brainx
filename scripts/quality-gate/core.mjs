import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const SECRET_RULES = [
  {
    id: "private-key",
    label: "私钥",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    id: "github-token",
    label: "GitHub Token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  {
    id: "openai-key",
    label: "OpenAI API Key",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: "aws-access-key",
    label: "AWS Access Key",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "slack-token",
    label: "Slack Token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: "stripe-live-key",
    label: "Stripe Live Key",
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "credential-url",
    label: "带账号密码的 URL",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
  },
];

export function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const parts = text.split(/\r\n|\n|\r/);
  return parts.length - (/\r\n$|\n$|\r$/.test(text) ? 1 : 0);
}

export function checkTrackedFilesPresent(files, exists = existsSync) {
  return files.filter((path) => !exists(path));
}

export function checkUnsafeTrackedEntries(files, stat = lstatSync) {
  const findings = [];
  for (const path of files) {
    try {
      if (stat(path).isSymbolicLink()) {
        findings.push({ path, reason: "Git 跟踪的符号链接会绕过内容扫描" });
      }
    } catch {
      // 缺失条目由 checkTrackedFilesPresent 统一报告。
    }
  }
  return findings;
}

export function selectRegularFiles(files, stat = lstatSync) {
  return files.filter((path) => {
    try {
      return stat(path).isFile();
    } catch {
      return false;
    }
  });
}

export function isExcluded(path, config) {
  if ((config.excludedPrefixes || []).some((prefix) => path.startsWith(prefix))) return true;
  if ((config.excludedFiles || []).includes(path)) return true;
  if ((config.excludedBasenames || []).includes(basename(path))) return true;
  return false;
}

export function isLineChecked(path, config) {
  return (config.lineExtensions || []).includes(extname(path).toLowerCase())
    && !isExcluded(path, config);
}

export function checkLineLimits(files, config, baseline, readText = defaultReadText) {
  const registered = new Map(
    (baseline.oversizedFiles || []).map((entry) => [entry.path, entry]),
  );
  const findings = [];

  for (const path of files.filter((item) => isLineChecked(item, config))) {
    const lines = countPhysicalLines(readText(path));
    const exception = registered.get(path);
    if (lines <= config.maxFileLines) {
      if (exception) {
        findings.push({ path, lines, reason: "文件已符合行数上限，应删除存量例外" });
      }
      continue;
    }
    if (!exception) {
      findings.push({ path, lines, reason: "超过行数上限且未登记存量基线" });
      continue;
    }
    if (isExpired(exception.expiresOn)) {
      findings.push({ path, lines, reason: "存量例外已到期" });
      continue;
    }
    if (lines !== exception.maxLines) {
      findings.push({
        path,
        lines,
        reason: lines > exception.maxLines
          ? "存量超限文件继续增长，登记上限为 " + exception.maxLines
          : "存量超限文件已缩小，应将登记上限收紧为 " + lines,
      });
    }
  }

  for (const entry of registered.values()) {
    if (!files.includes(entry.path)) {
      findings.push({ path: entry.path, lines: null, reason: "基线指向不存在或未跟踪的文件" });
    }
  }
  return findings;
}

export function checkLongLines(files, config, baseline, readText = defaultReadText) {
  const registered = new Map(
    (baseline.longLineFiles || []).map((entry) => [entry.path, entry]),
  );
  const findings = [];
  for (const path of files.filter((item) => isLineChecked(item, config))) {
    const lengths = readText(path).split(/\r\n|\n|\r/).map((line) => line.length);
    const long = lengths.filter((length) => length > config.maxLineLength);
    const entry = registered.get(path);
    if (long.length === 0) {
      if (entry) {
        findings.push({ path, longLines: 0, longest: 0, reason: "文件已无超长行，应删除存量例外" });
      }
      continue;
    }
    const longest = Math.max(...long);
    if (!entry) {
      findings.push({ path, longLines: long.length, longest, reason: "存在超长行且未登记存量基线" });
    } else if (isExpired(entry.expiresOn)) {
      findings.push({ path, longLines: long.length, longest, reason: "超长行例外已到期" });
    } else if (long.length !== entry.maxLongLines || longest !== entry.maxLength) {
      findings.push({
        path,
        longLines: long.length,
        longest,
        reason: long.length > entry.maxLongLines || longest > entry.maxLength
          ? "存量超长行继续恶化"
          : "存量超长行已改善，应同步收紧登记基线",
      });
    }
  }
  for (const entry of registered.values()) {
    if (!files.includes(entry.path)) {
      findings.push({ path: entry.path, longLines: 0, longest: 0, reason: "超长行基线指向不存在的文件" });
    }
  }
  return findings;
}

export function scanPortablePaths(files, config, baseline, readText = defaultReadText) {
  const allow = new Set(
    (baseline.portablePathExemptions || []).map((entry) =>
      entry.rule + "|" + entry.path + "|" + entry.fingerprint),
  );
  const findings = [];
  const rules = (config.portablePathPatterns || []).map((entry) => ({
    ...entry,
    regex: new RegExp(entry.pattern, "g"),
  }));
  for (const path of files.filter((item) => isLineChecked(item, config))) {
    const lines = readText(path).split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const rule of rules) {
        rule.regex.lastIndex = 0;
        if (!rule.regex.test(lines[index])) continue;
        const fingerprint = createHash("sha256").update(lines[index]).digest("hex").slice(0, 16);
        const key = rule.id + "|" + path + "|" + fingerprint;
        const entry = (baseline.portablePathExemptions || []).find((item) =>
          item.rule + "|" + item.path + "|" + item.fingerprint === key);
        if (!allow.has(key) || isExpired(entry?.expiresOn)) {
          findings.push({
            path,
            line: index + 1,
            rule: rule.id,
            label: rule.label,
            fingerprint,
            reason: allow.has(key) ? "本机路径例外已到期" : "发现未登记的本机绝对路径",
          });
        }
      }
    }
  }
  return findings;
}

export function checkTextHygiene(files, config, baseline = {}, readBuffer = defaultReadBuffer) {
  const findings = [];
  const registered = new Map(
    (baseline.textHygieneFiles || []).map((entry) => [entry.path, entry]),
  );
  const excluded = config.textHygieneExcludedPrefixes || [];
  const maxBytes = config.textHygieneMaxBytes || 2_000_000;
  for (const path of files) {
    if (excluded.some((prefix) => path.startsWith(prefix))) continue;
    const buffer = readBuffer(path);
    if (buffer.length > maxBytes || buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const crlf = (text.match(/\r\n/g) || []).length;
    const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
    const mixed = crlf > 0 && bareLf > 0;
    const entry = registered.get(path);
    const validEntry = entry && !isExpired(entry.expiresOn);
    if (mixed && !(validEntry && entry.allowMixedEol)) {
      findings.push({ path, line: null, reason: "混用了 CRLF 与 LF 换行" });
    }
    const lines = text.split(/\r\n|\n|\r/);
    const trailing = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (/[ \t]+$/.test(lines[index])) trailing.push(index + 1);
    }
    if (trailing.length > (validEntry ? entry.maxTrailingWhitespace || 0 : 0)) {
      for (const line of trailing) {
        findings.push({ path, line, reason: "行尾存在空格或制表符" });
      }
    }
  }
  return findings;
}

export function checkForbiddenTracked(files, config) {
  const allow = (config.allowedTrackedPatterns || []).map((value) => new RegExp(value));
  const deny = (config.forbiddenTrackedPatterns || []).map((value) => new RegExp(value));
  return files.filter((path) => deny.some((regex) => regex.test(path))
    && !allow.some((regex) => regex.test(path)));
}

export function scanSecrets(files, config, baseline, readBuffer = defaultReadBuffer) {
  const allow = new Set(
    (baseline.secretAllowlist || []).map((entry) => entry.rule + "|" + entry.path + "|" + entry.fingerprint),
  );
  const findings = [];
  const maxBytes = config.secretScanMaxBytes || 2_000_000;

  for (const path of files) {
    if ((config.secretExcludedPrefixes || []).some((prefix) => path.startsWith(prefix))) continue;
    const buffer = readBuffer(path);
    if (buffer.length > maxBytes || buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const rule of SECRET_RULES) {
      rule.regex.lastIndex = 0;
      for (const match of text.matchAll(rule.regex)) {
        const value = match[0];
        const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 16);
        const key = rule.id + "|" + path + "|" + fingerprint;
        if (allow.has(key)) continue;
        const line = text.slice(0, match.index).split(/\r\n|\n|\r/).length;
        findings.push({ path, line, rule: rule.id, label: rule.label, fingerprint });
      }
    }
  }
  return findings;
}

export function checkLockfiles(config, readText = defaultReadText) {
  const findings = [];
  for (const pair of config.manifests || []) {
    if (!existsSync(pair.manifest) || !existsSync(pair.lockfile)) {
      findings.push({ ...pair, reason: "依赖清单或 lockfile 不存在" });
      continue;
    }
    let manifest;
    let lock;
    try {
      manifest = JSON.parse(readText(pair.manifest));
      lock = JSON.parse(readText(pair.lockfile));
    } catch (error) {
      findings.push({ ...pair, reason: "JSON 无法解析：" + error.message });
      continue;
    }
    const root = lock.packages?.[""];
    if (!root) {
      findings.push({ ...pair, reason: "lockfile 缺少 packages 根记录" });
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const expected = manifest[field] || {};
      const actual = root[field] || {};
      if (JSON.stringify(sortedObject(expected)) !== JSON.stringify(sortedObject(actual))) {
        findings.push({ ...pair, field, reason: "package.json 与 lockfile 不一致" });
      }
    }
  }
  return findings;
}

export function auditLintIgnores(config, baseline, readText = defaultReadText) {
  const registered = new Map(
    (baseline.lintFileExemptions || []).map((entry) => [entry.path, entry]),
  );
  const findings = [];
  for (const audit of config.lintIgnoreAudits || []) {
    const source = readText(audit.file);
    const call = /globalIgnores\s*\(\s*\[([\s\S]*?)\]\s*\)/m.exec(source);
    if (!call) {
      findings.push({ path: audit.file, reason: "未找到可审计的 globalIgnores 数组" });
      continue;
    }
    const withoutComments = call[1].replace(/\/\/.*$/gm, "");
    const values = [];
    for (const match of withoutComments.matchAll(/["']([^"']+)["']/g)) values.push(match[1]);
    for (const value of values) {
      if ((audit.standardIgnores || []).includes(value)) continue;
      const entry = registered.get(value);
      if (!entry) {
        findings.push({ path: value, reason: "整文件 Lint 豁免未登记" });
      } else if (isExpired(entry.expiresOn)) {
        findings.push({ path: value, reason: "整文件 Lint 豁免已到期" });
      }
    }
    for (const entry of registered.values()) {
      if (!values.includes(entry.path)) {
        findings.push({ path: entry.path, reason: "Lint 豁免基线已失效，应删除登记" });
      }
    }
  }
  return findings;
}

export async function runCommand(spec, options = {}) {
  const startedAt = Date.now();
  const executable = process.platform === "win32" && spec.command === "npm"
    ? "npm.cmd"
    : spec.command;
  const child = spawn(executable, spec.args || [], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, CI: "true", ...(spec.env || {}) },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdoutOutput = "";
  let stderrOutput = "";
  const append = (chunk, streamName) => {
    const text = chunk.toString();
    output += text;
    if (streamName === "stdout") stdoutOutput += text;
    else stderrOutput += text;
  };
  child.stdout.on("data", (chunk) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk) => append(chunk, "stderr"));

  let timedOut = false;
  const timeoutMs = spec.timeoutMs || 60_000;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child);
  }, timeoutMs);

  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(timer);
  const safeStdout = redactOutput(stdoutOutput);
  const safeStderr = redactOutput(stderrOutput);
  if (safeStdout) (options.stdout || process.stdout).write(safeStdout);
  if (safeStderr) (options.stderr || process.stderr).write(safeStderr);
  return {
    ...outcome,
    timedOut,
    durationMs: Date.now() - startedAt,
    outputTail: redactOutput(output).slice(-12_000),
  };
}

export function parseNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.replace(/^v/, ""));
  return match ? match.slice(1).map(Number) : null;
}

export function versionAtLeast(actual, minimum) {
  const left = parseNodeVersion(actual);
  const right = parseNodeVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export function isExpired(date, now = new Date()) {
  if (!date) return true;
  const deadline = new Date(date + "T23:59:59.999Z");
  return Number.isNaN(deadline.getTime()) || now > deadline;
}

function terminateTree(child) {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 2_000).unref();
    }
  } catch {}
}

function redactOutput(value) {
  let result = value;
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    result = result.replace(rule.regex, "[REDACTED:" + rule.id + "]");
  }
  return result;
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function defaultReadText(path) {
  return readFileSync(path, "utf8");
}

function defaultReadBuffer(path) {
  return readFileSync(path);
}
