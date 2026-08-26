import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  auditLintIgnores,
  checkForbiddenTracked,
  checkLineLimits,
  checkLongLines,
  checkLockfiles,
  checkTextHygiene,
  checkTrackedFilesPresent,
  checkUnsafeTrackedEntries,
  countPhysicalLines,
  runCommand,
  scanPortablePaths,
  scanSecrets,
  selectRegularFiles,
  versionAtLeast,
} from "../scripts/quality-gate/core.mjs";

test("Node 22 测试入口显式启用 TypeScript 类型剥离", () => {
  const repoRoot = new URL("../", import.meta.url);
  for (const manifestPath of [
    "package.json",
    "frontend/btex-frontend/package.json",
  ]) {
    const manifest = JSON.parse(
      readFileSync(new URL(manifestPath, repoRoot), "utf8"),
    );
    assert.match(
      manifest.scripts.test,
      /(?:^|\s)node --experimental-strip-types(?:\s|$)/,
      `${manifestPath} 的测试入口必须兼容 Node 22 加载 TypeScript`,
    );
  }
});

test("根测试入口只扫描活动测试目录，不执行归档副本", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(manifest.scripts.test, /--test --test-force-exit "tests\/\*\.test\.mjs"$/);
  assert.doesNotMatch(manifest.scripts.test, /_archive/);
});

test("门禁分层执行前端、Storybook 与浏览器链路测试", () => {
  const root = new URL("../", import.meta.url);
  const config = JSON.parse(
    readFileSync(new URL(".quality-gate/config.json", root), "utf8"),
  );
  const frontend = JSON.parse(
    readFileSync(new URL("frontend/btex-frontend/package.json", root), "utf8"),
  );
  assert.doesNotMatch(frontend.scripts.test, /build/);
  assert.equal(frontend.scripts["test:e2e"], "node tests/e2e-browser-check.mjs");
  assert.match(frontend.scripts["storybook:test"], /vitest --project storybook --run/);
  assert.match(frontend.scripts["storybook:build"], /storybook build/);
  assert.equal(
    config.profiles.quick.commands.some((item) => item.name === "前端静态与适配测试"),
    true,
  );
  for (const profileName of ["full", "ci"]) {
    const names = config.profiles[profileName].commands.map((item) => item.name);
    assert.equal(names.filter((name) => name === "后端与共享逻辑测试").length, 1);
    assert.equal(names.filter((name) => name === "前端静态与适配测试").length, 1);
    assert.equal(names.filter((name) => name === "Storybook 组件交互测试").length, 1);
    assert.equal(names.filter((name) => name === "Storybook 静态构建").length, 1);
    assert.equal(names.filter((name) => name === "浏览器前后端链路").length, 1);
    assert(names.indexOf("Storybook 静态构建") > names.indexOf("Storybook 组件交互测试"));
    assert(names.indexOf("浏览器前后端链路") > names.indexOf("前端生产构建"));
  }
});

test("物理行计数兼容空文件、末尾换行和 CRLF", () => {
  assert.equal(countPhysicalLines(""), 0);
  assert.equal(countPhysicalLines("a"), 1);
  assert.equal(countPhysicalLines("a\n"), 1);
  assert.equal(countPhysicalLines("a\r\nb\r\n"), 2);
});

test("完整检出检查会列出缺失的被跟踪文件", () => {
  const present = new Set(["src/server.js", "package.json"]);
  assert.deepEqual(
    checkTrackedFilesPresent(
      ["src/server.js", "docs/hidden.md", "package.json"],
      (path) => present.has(path),
    ),
    ["docs/hidden.md"],
  );
});

test("扫描文件集合排除 Gitlink 目录", () => {
  const kinds = new Map([
    ["src/server.js", "file"],
    ["brainx", "directory"],
  ]);
  assert.deepEqual(
    selectRegularFiles(
      ["src/server.js", "brainx"],
      (path) => ({ isFile: () => kinds.get(path) === "file" }),
    ),
    ["src/server.js"],
  );
});

test("Git 跟踪的符号链接不能绕过安全扫描", () => {
  const kinds = new Map([
    ["src/server.js", "file"],
    ["keys/prod.pem", "symlink"],
  ]);
  const findings = checkUnsafeTrackedEntries(
    [...kinds.keys()],
    (path) => ({ isSymbolicLink: () => kinds.get(path) === "symlink" }),
  );
  assert.deepEqual(findings, [{
    path: "keys/prod.pem",
    reason: "Git 跟踪的符号链接会绕过内容扫描",
  }]);
});

test("500 行基线只允许存量文件不增长且未到期", () => {
  const config = {
    maxFileLines: 3,
    lineExtensions: [".js"],
    excludedPrefixes: [],
    excludedFiles: [],
    excludedBasenames: [],
  };
  const baseline = {
    oversizedFiles: [{
      path: "legacy.js",
      maxLines: 4,
      owner: "test",
      reason: "fixture",
      expiresOn: "2999-01-01",
    }],
  };
  const text = {
    "ok.js": "1\n2\n3\n",
    "legacy.js": "1\n2\n3\n4\n",
    "new.js": "1\n2\n3\n4\n",
  };
  const findings = checkLineLimits(Object.keys(text), config, baseline, (path) => text[path]);
  assert.deepEqual(findings, [{
    path: "new.js",
    lines: 4,
    reason: "超过行数上限且未登记存量基线",
  }]);

  text["legacy.js"] += "5\n";
  const growth = checkLineLimits(Object.keys(text), config, baseline, (path) => text[path]);
  assert.equal(growth.some((item) => item.path === "legacy.js"), true);

  text["legacy.js"] = "1\n2\n3\n";
  const stale = checkLineLimits(Object.keys(text), config, baseline, (path) => text[path]);
  assert.equal(stale.some((item) => item.path === "legacy.js"), true);
});

test("禁止文件规则允许显式的 env 示例", () => {
  const config = {
    forbiddenTrackedPatterns: ["(^|/)\\.env($|\\.)", "\\.pem$"],
    allowedTrackedPatterns: ["(^|/)\\.env\\.example$"],
  };
  assert.deepEqual(
    checkForbiddenTracked([".env", ".env.example", "keys/prod.pem"], config),
    [".env", "keys/prod.pem"],
  );
});

test("文本卫生检查拒绝混合换行和行尾空白", () => {
  const files = ["mixed.txt", "space.txt", "ok.txt"];
  const values = {
    "mixed.txt": Buffer.from("a\r\nb\n"),
    "space.txt": Buffer.from("a  \n"),
    "ok.txt": Buffer.from("a\nb\n"),
  };
  const findings = checkTextHygiene(
    files,
    { textHygieneExcludedPrefixes: [], textHygieneMaxBytes: 1_000 },
    {},
    (path) => values[path],
  );
  assert.equal(findings.some((item) => item.path === "mixed.txt"), true);
  assert.equal(findings.some((item) => item.path === "space.txt"), true);
  assert.equal(findings.some((item) => item.path === "ok.txt"), false);
});

test("超长行基线只允许存量问题不恶化", () => {
  const config = {
    maxLineLength: 5,
    lineExtensions: [".js"],
    excludedPrefixes: [],
    excludedFiles: [],
    excludedBasenames: [],
  };
  const baseline = {
    longLineFiles: [{
      path: "legacy.js",
      maxLongLines: 1,
      maxLength: 6,
      owner: "test",
      reason: "fixture",
      expiresOn: "2999-01-01",
    }],
  };
  assert.deepEqual(checkLongLines(["legacy.js"], config, baseline, () => "123456\nok\n"), []);
  assert.equal(
    checkLongLines(["legacy.js"], config, baseline, () => "1234567\nok\n").length,
    1,
  );
  assert.equal(checkLongLines(["legacy.js"], config, baseline, () => "ok\n").length, 1);
});

test("个人电脑绝对路径按内容指纹登记", () => {
  const line = "node /" + "Users/example/project/server.mjs";
  const config = {
    lineExtensions: [".mjs"],
    excludedPrefixes: [],
    excludedFiles: [],
    excludedBasenames: [],
    portablePathPatterns: [{
      id: "mac-user-home",
      label: "macOS 用户目录",
      pattern: "(?:^|[\\s\"'])/Users/[^/\\s\"']+",
    }],
  };
  const findings = scanPortablePaths(
    ["server.mjs"],
    config,
    { portablePathExemptions: [] },
    () => line,
  );
  assert.equal(findings.length, 1);
  const allowed = {
    portablePathExemptions: [{
      rule: findings[0].rule,
      path: findings[0].path,
      fingerprint: findings[0].fingerprint,
      owner: "test",
      reason: "fixture",
      expiresOn: "2999-01-01",
    }],
  };
  assert.deepEqual(scanPortablePaths(["server.mjs"], config, allowed, () => line), []);
});

test("秘密扫描只报告位置和指纹，不泄露原值", () => {
  const fakeKey = "ghp_" + "A".repeat(36);
  const findings = scanSecrets(
    ["src/example.js"],
    { secretScanMaxBytes: 1_000, secretExcludedPrefixes: [] },
    { secretAllowlist: [] },
    () => Buffer.from("const value = \"" + fakeKey + "\";\n"),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "src/example.js");
  assert.equal(findings[0].line, 1);
  assert.equal(JSON.stringify(findings).includes(fakeKey), false);
});

test("lockfile 根记录必须与依赖清单一致", () => {
  const values = {
    "package.json": JSON.stringify({ dependencies: { mysql2: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      packages: { "": { dependencies: { mysql2: "1.0.0" } } },
    }),
  };
  const config = { manifests: [{ manifest: "package.json", lockfile: "package-lock.json" }] };
  assert.deepEqual(checkLockfiles(config, (path) => values[path]), []);
  values["package-lock.json"] = JSON.stringify({
    packages: { "": { dependencies: { mysql2: "2.0.0" } } },
  });
  assert.equal(checkLockfiles(config, (path) => values[path]).length, 1);
});

test("整文件 Lint 豁免必须登记且不能过期", () => {
  const source = "globalIgnores([\n  \".next/**\",\n  \"app/legacy.tsx\",\n]);";
  const config = {
    lintIgnoreAudits: [{
      file: "eslint.config.mjs",
      standardIgnores: [".next/**"],
    }],
  };
  const valid = {
    lintFileExemptions: [{
      path: "app/legacy.tsx",
      owner: "test",
      reason: "fixture",
      expiresOn: "2999-01-01",
    }],
  };
  assert.deepEqual(auditLintIgnores(config, valid, () => source), []);
  assert.equal(auditLintIgnores(config, { lintFileExemptions: [] }, () => source).length, 1);
});

test("外部命令超时后返回失败证据", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.durationMs >= 90, true);
});

test("外部命令输出在写入日志前完成秘密脱敏", async () => {
  const fakeKey = "ghp_" + "A".repeat(36);
  let logged = "";
  const sink = { write: (value) => { logged += value; } };
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(fakeKey)})`],
    timeoutMs: 1_000,
  }, { stdout: sink, stderr: sink });
  assert.equal(result.code, 0);
  assert.equal(logged.includes(fakeKey), false);
  assert.equal(result.outputTail.includes(fakeKey), false);
  assert.match(logged, /\[REDACTED:github-token\]/);
});

test("Node 版本比较按语义版本工作", () => {
  assert.equal(versionAtLeast("v22.13.0", "22.13.0"), true);
  assert.equal(versionAtLeast("22.12.9", "22.13.0"), false);
  assert.equal(versionAtLeast("23.0.0", "22.13.0"), true);
});
