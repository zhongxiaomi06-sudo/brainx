import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");

test("personal model UI submits keys only in the authenticated request body", async () => {
  const [panel, api] = await Promise.all([
    source("app/personal-model-panel.tsx"),
    source("app/personal-model-api.ts"),
  ]);
  assert.match(panel, /type="password"/);
  assert.match(panel, /consent_version/);
  assert.match(panel, /setApiKey\(""/);
  assert.doesNotMatch(panel + api, /localStorage|sessionStorage|URLSearchParams.*api_key/);
  assert.match(api, /method: "PUT", body: input/);
  assert.doesNotMatch(api, /\?api_key|\/model-profile\//);
});

test("personal model UI explains isolation, consent and unavailable Agent recovery", async () => {
  const panel = await source("app/personal-model-panel.tsx");
  assert.match(panel, /其他人及群聊不会共用/);
  assert.match(panel, /脱敏业务内容会发送给所选模型供应商处理/);
  assert.match(panel, /先在飞书私聊/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /disabled=\{busy/);
});
