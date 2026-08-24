#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import {
  auditLintIgnores,
  checkForbiddenTracked,
  checkTrackedFilesPresent,
  checkLineLimits,
  checkLongLines,
  checkLockfiles,
  checkTextHygiene,
  isExcluded,
  runCommand,
  scanPortablePaths,
  scanSecrets,
  selectRegularFiles,
  versionAtLeast,
} from "./quality-gate/core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const config = readTrackedJson(".quality-gate/config.json");
const baseline = readTrackedJson(".quality-gate/baseline.json");
const profileName = parseProfile(process.argv.slice(2));
const profile = config.profiles[profileName];
if (!profile) {
  console.error("未知门禁配置：" + profileName);
  process.exit(2);
}

const startedAt = new Date();
const files = trackedFiles();
const checks = [];

console.log("\nBrainX 质量门禁");
console.log("配置：" + profileName + "｜开始：" + startedAt.toISOString() + "\n");

addCheck(
  "环境",
  "Node.js 版本",
  versionAtLeast(process.version, config.minimumNodeVersion),
  "当前 " + process.version + "，最低要求 v" + config.minimumNodeVersion,
);

const gitState = inspectGitState(profile.requireCleanWorktree);
addCheck("Git", "工作区与操作状态", gitState.ok, gitState.detail);

const missingTrackedFiles = checkTrackedFilesPresent(listTrackedFiles());
addCheck(
  "Git",
  "完整检出",
  missingTrackedFiles.length === 0,
  missingTrackedFiles.length
    ? "当前工作区缺少 " + missingTrackedFiles.length + " 个被 Git 跟踪的文件，门禁不能安全扫描稀疏检出；请先执行 git sparse-checkout disable。示例：\n"
      + missingTrackedFiles.slice(0, 20).join("\n")
    : "全部被 Git 跟踪的文件都已检出",
);

const forbidden = checkForbiddenTracked(files, config);
addCheck(
  "安全",
  "禁止跟踪文件",
  forbidden.length === 0,
  forbidden.length ? forbidden.join("\n") : "未发现被 Git 跟踪的禁止文件",
);

const secrets = scanSecrets(files, config, baseline);
addCheck(
  "安全",
  "高置信度秘密扫描",
  secrets.length === 0,
  secrets.length
    ? secrets.map((item) => item.path + ":" + item.line + " " + item.label
      + " fingerprint=" + item.fingerprint).join("\n")
    : "未发现私钥或高置信度 Token",
);

const lineFindings = checkLineLimits(files, config, baseline);
addCheck(
  "结构",
  "500 行与存量基线",
  lineFindings.length === 0,
  lineFindings.length
    ? lineFindings.map((item) => item.path + "："
      + (item.lines === null ? "" : item.lines + " 行，") + item.reason).join("\n")
    : "新文件未超限，登记的存量文件没有增长且未到期",
);

const longLineFindings = checkLongLines(files, config, baseline);
addCheck(
  "结构",
  "超长行与压缩规避",
  longLineFindings.length === 0,
  longLineFindings.length
    ? longLineFindings.map((item) => item.path + "：超长行 " + item.longLines
      + " 条，最长 " + item.longest + " 字符，" + item.reason).join("\n")
    : "未出现新的超长行，登记的存量文件没有恶化且未到期",
);

const portablePaths = scanPortablePaths(files, config, baseline);
addCheck(
  "可移植性",
  "个人电脑绝对路径",
  portablePaths.length === 0,
  portablePaths.length
    ? portablePaths.map((item) => item.path + ":" + item.line + " " + item.label
      + " fingerprint=" + item.fingerprint + "，" + item.reason).join("\n")
    : "未发现新增或过期的个人电脑绝对路径",
);

const textHygiene = checkTextHygiene(files, config, baseline);
addCheck(
  "格式",
  "换行与行尾空白",
  textHygiene.length === 0,
  textHygiene.length
    ? textHygiene.map((item) => item.path + (item.line ? ":" + item.line : "")
      + "：" + item.reason).join("\n")
    : "未发现混合换行或行尾空白",
);

const lintIgnores = auditLintIgnores(config, baseline);
addCheck(
  "结构",
  "整文件 Lint 豁免审计",
  lintIgnores.length === 0,
  lintIgnores.length
    ? lintIgnores.map((item) => item.path + "：" + item.reason).join("\n")
    : "未发现未登记或过期的整文件豁免",
);

const lockFindings = checkLockfiles(config);
addCheck(
  "依赖",
  "依赖清单与 lockfile",
  lockFindings.length === 0,
  lockFindings.length
    ? lockFindings.map((item) => item.manifest + "：" + item.reason).join("\n")
    : "根目录和前端依赖声明与 lockfile 一致",
);

await runSyntaxChecks(files);
for (const command of profile.commands) await runConfiguredCommand(command);

const finishedAt = new Date();
const failed = checks.filter((check) => check.status === "failed");
const report = {
  schemaVersion: 1,
  profile: profileName,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  git: {
    branch: git(["branch", "--show-current"]).trim() || "(detached)",
    commit: git(["rev-parse", "HEAD"]).trim(),
  },
  summary: {
    status: failed.length === 0 ? "passed" : "failed",
    passed: checks.length - failed.length,
    failed: failed.length,
    total: checks.length,
    pushAllowed: failed.length === 0 && profileName !== "quick",
  },
  checks,
};

writeReports(report);
console.log("\n" + (failed.length === 0 ? "✅" : "❌") + " 门禁结论："
  + (failed.length === 0 ? "通过" : "未通过"));
console.log("检查 " + checks.length + " 项，通过 " + report.summary.passed
  + " 项，失败 " + failed.length + " 项");
console.log("报告：" + join(config.reportDirectory, "latest.md"));
if (profileName === "quick") {
  console.log("注意：quick 仅用于开发反馈，不能作为 push 依据。");
}
process.exitCode = failed.length === 0 ? 0 : 1;

function addCheck(stage, name, passed, detail, extra = {}) {
  const check = {
    stage,
    name,
    status: passed ? "passed" : "failed",
    detail,
    ...extra,
  };
  checks.push(check);
  console.log((passed ? "✓ " : "✗ ") + stage + " / " + name);
  if (!passed) console.log(indent(detail));
}

async function runSyntaxChecks(allFiles) {
  const candidates = allFiles.filter((path) =>
    [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase())
      && !isExcluded(path, config));
  const failures = [];
  let durationMs = 0;
  for (const path of candidates) {
    const result = await runCommand({
      command: process.execPath,
      args: ["--check", path],
      timeoutMs: config.syntaxCheckTimeoutMs,
    });
    durationMs += result.durationMs;
    if (result.code !== 0 || result.timedOut || result.error) {
      failures.push(path + "：" + commandFailure(result));
    }
  }
  addCheck(
    "静态质量",
    "Node.js 语法检查",
    failures.length === 0,
    failures.length ? failures.join("\n") : "已检查 " + candidates.length + " 个文件",
    { durationMs },
  );
}

async function runConfiguredCommand(command) {
  console.log("→ " + command.stage + " / " + command.name);
  const result = await runCommand(command, { cwd: root });
  const passed = result.code === 0 && !result.timedOut && !result.error;
  addCheck(
    command.stage,
    command.name,
    passed,
    passed
      ? "退出码 0，耗时 " + formatDuration(result.durationMs)
      : commandFailure(result),
    {
      command: [command.command, ...(command.args || [])].join(" "),
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputTail: result.outputTail,
    },
  );
}

function inspectGitState(requireClean) {
  const issues = [];
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (requireClean && status) issues.push("工作区不是干净状态：\n" + status);
  if (/^(?:UU|AA|DD|AU|UA|DU|UD) /m.test(status)) issues.push("存在未解决冲突");
  for (const state of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const path = git(["rev-parse", "--git-path", state]).trim();
    if (path && existsSync(path)) issues.push("存在未完成 Git 操作：" + state);
  }
  const detail = issues.length
    ? issues.join("\n")
    : requireClean
      ? "工作区干净，且没有未完成的 Git 操作"
      : status
        ? "开发态允许未提交改动；未发现冲突或未完成 Git 操作"
        : "工作区干净，且没有未完成的 Git 操作";
  return { ok: issues.length === 0, detail };
}

function writeReports(report) {
  mkdirSync(config.reportDirectory, { recursive: true });
  writeFileSync(
    join(config.reportDirectory, "latest.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  const rows = report.checks.map((check) =>
    "| " + escapeCell(check.stage) + " | " + escapeCell(check.name) + " | "
      + (check.status === "passed" ? "通过" : "失败") + " | "
      + escapeCell(check.detail.split("\n")[0]) + " |");
  const failures = report.checks
    .filter((check) => check.status === "failed")
    .map((check) => "### " + check.stage + " / " + check.name + "\n\n"
      + "    " + check.detail.replace(/\n/g, "\n    "))
    .join("\n\n");
  const markdown = [
    "# 质量门禁报告",
    "",
    "- 配置：" + report.profile,
    "- Commit：" + report.git.commit,
    "- 结论：" + (report.summary.status === "passed" ? "通过" : "未通过"),
    "- Push 条件：" + (report.summary.pushAllowed ? "满足" : "不满足"),
    "- 时间：" + report.startedAt + " → " + report.finishedAt,
    "",
    "| 阶段 | 检查 | 结果 | 摘要 |",
    "|---|---|---|---|",
    ...rows,
    failures ? "" : null,
    failures ? "## 失败详情" : null,
    failures || null,
    "",
  ].filter((line) => line !== null).join("\n");
  writeFileSync(join(config.reportDirectory, "latest.md"), markdown);
}

function trackedFiles() {
  const output = execFileSync("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return selectRegularFiles(output.toString("utf8").split("\0").filter(Boolean));
}

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z", "--cached"]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function readTrackedJson(path) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  try {
    return JSON.parse(git(["show", ":" + path]));
  } catch {
    return JSON.parse(git(["show", "HEAD:" + path]));
  }
}

function parseProfile(args) {
  const index = args.indexOf("--profile");
  return index >= 0 ? args[index + 1] : "full";
}

function commandFailure(result) {
  if (result.timedOut) return "超时，耗时 " + formatDuration(result.durationMs);
  if (result.error) return "无法启动：" + result.error;
  return "退出码 " + result.code + (result.signal ? "，信号 " + result.signal : "")
    + "，耗时 " + formatDuration(result.durationMs);
}

function formatDuration(milliseconds) {
  return milliseconds < 1_000
    ? milliseconds + "ms"
    : (milliseconds / 1_000).toFixed(1) + "s";
}

function indent(value) {
  return "  " + String(value).replace(/\n/g, "\n  ");
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
