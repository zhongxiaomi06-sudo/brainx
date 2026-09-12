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
  isLineChecked,
  runCommand,
  scanPortablePaths,
  scanSecrets,
  selectRegularFiles,
  versionAtLeast,
} from "../scripts/quality-gate/core.mjs";
import { canonicalize } from "../scripts/quality-gate/card-render/run.mjs";
import { renderCard, renderElements } from "../scripts/quality-gate/card-render/renderer.mjs";
import {
  checkTypography,
  MAX_ACTION_BUTTONS,
  MAX_BLOCK_LINES,
} from "../scripts/quality-gate/card-render/typography.mjs";
import { buildScenarios } from "../scripts/quality-gate/card-render/scenarios.mjs";
import { candidateShareCard } from "../src/agent-gateway/tools-candidate-actions.js";

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

test("Spec Kit 官方生成脚本不按手写源码行数审计", () => {
  const config = {
    lineExtensions: [".sh"],
    excludedPrefixes: [".specify/scripts/bash/"],
    excludedFiles: [],
    excludedBasenames: [],
  };
  assert.equal(isLineChecked(".specify/scripts/bash/common.sh", config), false);
  assert.equal(isLineChecked("scripts/common.sh", config), true);
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

test("飞书卡片渲染门禁接入 full 与 ci，但不拖慢 quick", () => {
  const config = JSON.parse(
    readFileSync(new URL("../.quality-gate/config.json", import.meta.url), "utf8"),
  );
  const names = (profile) => config.profiles[profile].commands.map((item) => item.name);
  for (const profile of ["full", "ci"]) {
    const entry = config.profiles[profile].commands
      .find((item) => item.name.includes("卡片渲染回归"));
    assert.ok(entry, `${profile} 必须包含飞书群卡片渲染回归`);
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["scripts/quality-gate/card-render/run.mjs"]);
    assert.ok(entry.timeoutMs > 0, `${profile} 的渲染门禁必须设置超时`);
  }
  assert.equal(names("quick").some((name) => name.includes("卡片渲染")), false);
});

test("卡片渲染门禁归一化可变字段，避免截图基线天天漂移", () => {
  const card = {
    header: { content: "2026-09-12T10:42:00Z" },
    elements: ["run: a1b2c3d4e5f6", "day=2026-09-12", "TTC-8842137", 86, true],
  };
  const result = canonicalize(card);
  assert.deepEqual(result, {
    header: { content: "«TS»" },
    elements: ["run: «HEX»", "day=«DATE»", "TTC-8842137", 86, true],
  });
  // 卡片标题用的是 now().slice(5, 16) 的相对形式（「09-12 19:05」/「09-12T19:05」）：
  // 漏掉它，标题就随时钟逐分钟变化，基线每次 --update 都被改写，门禁还可能因为
  // 分钟数字位数变化而偶发阻断。带年份的完整时间戳不得被它截断成半截。
  assert.equal(canonicalize("推荐 09-12 19:05"), "推荐 «TS»");
  assert.equal(canonicalize("提醒 09-12T19:05"), "提醒 «TS»");
  assert.equal(canonicalize("推荐 2026-09-12T19:05"), "推荐 «TS»");
});

test("卡片渲染器遇到未覆盖元素类型必须抛错，不得静默跳过", () => {
  assert.throws(
    () => renderElements([{ tag: "chart", chart_spec: {} }]),
    /未覆盖的元素类型：chart/,
  );
});

test("卡片渲染器能把真实构建出的候选人卡转成可截图 DOM", () => {
  const card = candidateShareCard("proj-1", "TTC-8842137", { name: "李燊", role: "影像算法产品经理" });
  const html = renderCard(card, { cardId: "candidate-share" });
  assert.match(html, /feishu-card/);
  assert.match(html, /查看链接/);
  assert.match(html, /一键加入人才库/);
});

test("卡片存量缺陷登记必须带到期日，不得无限期挂账", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../fixtures/card-render/known-defects.json", import.meta.url), "utf8"),
  );
  // 空表是目标状态（存量缺陷清完就下线登记），一旦登记就必须写清归属与到期日。
  const defects = registry.defects || [];
  assert.ok(Array.isArray(defects), "defects 必须是数组");
  for (const defect of defects) {
    assert.ok(defect.id && defect.rule && defect.owner && defect.reason, "登记项字段不完整");
    assert.match(defect.expiresOn, /^\d{4}-\d{2}-\d{2}$/, "登记项必须写明到期日");
  }
});

test("排版纪律：单块正文超过行数上限即判文字墙", () => {
  const wall = Array.from({ length: MAX_BLOCK_LINES + 1 }, (_, index) => `第 ${index + 1} 行正文`);
  const issues = checkTypography({ elements: [{ tag: "markdown", content: wall.join("\n") }] });
  assert.deepEqual(issues.map((item) => item.rule), ["markdown-block-too-long"]);
});

test("排版纪律：列表行不计入正文行数，但总行数仍有上限", () => {
  const bullets = (count) => Array.from({ length: count }, (_, index) => `- 第 ${index + 1} 条`).join("\n");
  assert.deepEqual(checkTypography({
    elements: [{ tag: "markdown", content: `**原项目群候选讨论**\n以下内容只作为业务证据。\n${bullets(8)}` }],
  }), [], "列表可扫读，不应被当作文字墙");
  assert.deepEqual(checkTypography({
    elements: [{ tag: "markdown", content: `**原项目群候选讨论**\n${bullets(20)}` }],
  }).map((item) => item.rule), ["markdown-block-overflow"], "列表再长也不能无上限");
});

test("排版纪律：连续标签行超过 3 行必须分组", () => {
  const content = ["**依据**：A", "**风险**：B", "**行动**：C", "**备注**：D"].join("\n");
  assert.deepEqual(checkTypography({ elements: [{ tag: "markdown", content }] })
    .map((item) => item.rule), ["label-run-too-long"]);
});

test("排版纪律：动作块超过 3 个按钮即判截断风险，列内嵌套同样受检", () => {
  const card = { elements: [{ tag: "column_set", columns: [{ elements: [
    { tag: "action", actions: Array.from({ length: MAX_ACTION_BUTTONS + 1 }, () => ({ tag: "button" })) },
  ] }] }] };
  const issues = checkTypography(card);
  assert.deepEqual(issues.map((item) => item.rule), ["action-row-too-many-buttons"]);
  assert.match(issues[0].detail, /col\[0\]/, "表格列内的动作块也要被检查");
});

test("排版纪律：标签行必须全角冒号，标题行必须位于块首", () => {
  assert.deepEqual(checkTypography({ elements: [{ tag: "markdown", content: "**依据**: A" }] })
    .map((item) => item.rule), ["label-colon-halfwidth"]);
  assert.deepEqual(checkTypography({ elements: [{ tag: "markdown", content: "元信息行\n**标题**\n正文" }] })
    .map((item) => item.rule), ["heading-not-first"]);
});

test("排版纪律：全部生产卡片样本零违规", () => {
  const failures = buildScenarios()
    .map((scenario) => [scenario.id, checkTypography(canonicalize(scenario.card))])
    .filter(([, issues]) => issues.length);
  assert.deepEqual(failures, [], "生产卡片必须满足 docs/standards/CARD_TYPOGRAPHY.md 的硬规则");
});
