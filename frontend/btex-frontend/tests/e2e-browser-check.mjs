import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = mkdtempSync(join(tmpdir(), "brainx-browser-gate-"));
const output = [];
let app;
let browser;

const remember = (chunk) => {
  output.push(String(chunk));
  if (output.length > 200) output.shift();
};

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForApp(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`BrainX 提前退出 code=${child.exitCode}\n${output.join("").slice(-4000)}`);
    }
    try {
      const response = await fetch(`${url}/api/v1/meta/guard`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // 服务和前端子进程仍在启动。
    }
    await sleep(200);
  }
  throw new Error(`BrainX 启动超时\n${output.join("").slice(-4000)}`);
}

async function waitForFrontend(page, url, child) {
  const deadline = Date.now() + 60_000;
  let lastTitle = "";
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`BrainX 提前退出 code=${child.exitCode}\n${output.join("").slice(-4000)}`);
    }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
      lastTitle = await page.title();
      if (lastTitle === "B-tex · 职位决策工作台"
        && await page.getByRole("main").count()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`前端启动超时 title=${JSON.stringify(lastTitle)} error=${lastError}\n${output.join("").slice(-4000)}`);
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  const signal = (name) => {
    if (process.platform === "win32") child.kill(name);
    else {
      try { process.kill(-child.pid, name); } catch { child.kill(name); }
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    sleep(5_000).then(() => signal("SIGKILL")),
  ]);
}

try {
  const backendPort = await freePort();
  let frontendPort = await freePort();
  while (frontendPort === backendPort) frontendPort = await freePort();
  const base = `http://127.0.0.1:${backendPort}`;

  app = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BRAINX_ENV_FILE: join(temp, "missing.env"),
      BRAINX_DB: join(temp, "brainx.db"),
      BRAINX_HOST: "127.0.0.1",
      BRAINX_PORT: String(backendPort),
      BRAINX_FRONTEND_HOST: "127.0.0.1",
      BRAINX_FRONTEND_PORT: String(frontendPort),
      BRAINX_FRONTEND_OFF: "0",
      BRAINX_DEV_AUTH: "1",
      BRAINX_BRIDGE_OFF: "1",
      BRAINX_PUSH_AUTO: "0",
      BRAINX_PUSH_SCHEDULE: "0",
      BRAINX_LLM_DISABLE: "1",
      BRAINX_MYSQL_USER: "",
      BRAINX_MYSQL_PASSWORD: "",
      BRAINX_MYSQL_DATABASE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  app.stdout.on("data", remember);
  app.stderr.on("data", remember);
  await waitForApp(base, app);

  const channel = process.env.BRAINX_E2E_CHANNEL || "chrome";
  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const url = response.url();
    const isAsset = /\.(?:js|mjs|css|woff2?|ttf|svg|png)(?:\?|$)/.test(url);
    if (url.startsWith(base) && (response.status() >= 500 || (isAsset && response.status() >= 400))) {
      failedResponses.push(`${response.status()} ${url}`);
    }
  });

  await waitForFrontend(page, base, app);
  pageErrors.length = 0;
  consoleErrors.length = 0;
  failedResponses.length = 0;
  assert.equal(await page.title(), "B-tex · 职位决策工作台");
  await assert.doesNotReject(() => page.getByRole("main").waitFor({ state: "visible" }));
  const signedOutBody = await page.locator("body").innerText();
  assert.match(signedOutBody, /登录后查看真实职位/);
  assert.doesNotMatch(signedOutBody, /39-AI|CurioSea|科漫智能/);

  const loginStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consultant_id: "felix" }),
    });
    return response.status;
  });
  assert.equal(loginStatus, 204, "开发登录成功契约必须返回 204");
  pageErrors.length = 0;
  consoleErrors.length = 0;
  failedResponses.length = 0;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /身份：Felix/ }).waitFor({ state: "visible" });

  const workbenchStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/workbench");
    await response.text();
    return response.status;
  });
  assert.equal(workbenchStatus, 200, "登录后工作台 API 必须可用");

  const search = page.getByRole("textbox", { name: "搜索职位或公司" });
  if (await search.count()) {
    await search.fill("前端链路验证");
    assert.equal(await search.inputValue(), "前端链路验证");
    await search.fill("");
  } else {
    await page.getByRole("heading", { name: "还没有可判断的职位" }).waitFor({ state: "visible" });
  }

  await page.getByRole("button", { name: "全部职位" }).click();
  await page.getByRole("button", { name: "客户洞察" }).click();
  await page.getByRole("heading", { name: "客户洞察" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "连接与数据" }).click();
  await page.getByRole("heading", { name: "TTC 职位系统" }).waitFor({ state: "visible" });
  await page.getByLabel("TTC 凭证（ottin-jwt-token-v2）").waitFor({ state: "visible" });
  assert.match(await page.locator("main").innerText(), /真实职位的权威来源/);
  await page.getByRole("button", { name: "今日决策", exact: true }).click();
  await page.getByRole("heading", { name: /待判断职位|还没有可判断的职位/ }).waitFor({ state: "visible" });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  mobile.on("pageerror", (error) => pageErrors.push(`mobile: ${error.message}`));
  mobile.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`mobile: ${message.text()}`);
  });
  await mobile.goto(base, { waitUntil: "networkidle" });
  await mobile.getByRole("main").waitFor({ state: "visible" });
  assert.doesNotMatch(await mobile.locator("body").innerText(), /页面加载失败|出现了未处理的界面错误/);
  await mobile.close();

  const guard = await page.evaluate(async () => (await fetch("/api/v1/meta/guard")).json());
  assert.equal(guard.client_errors_total, 0, "浏览器错误不应上报到服务端看门狗");
  assert.deepEqual(pageErrors, [], `页面运行错误：${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `控制台错误：${consoleErrors.join(" | ")}`);
  assert.deepEqual(failedResponses, [], `静态资源或服务响应失败：${failedResponses.join(" | ")}`);
  console.log("浏览器链路通过：桌面/移动端渲染、登录、工作台 API、搜索、导航、资源与控制台均正常");
} catch (error) {
  console.error(error.stack || error.message || error);
  console.error(output.join("").slice(-4000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopApp(app);
  rmSync(temp, { recursive: true, force: true });
}
