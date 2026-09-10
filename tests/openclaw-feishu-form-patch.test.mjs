import test from 'node:test';
import assert from 'node:assert/strict';
import {
  patchCardActionFallback,
  patchCardActionParser,
} from '../deploy/openclaw/patch-feishu-form.mjs';

const parserFixture = `function parseFeishuCardActionEventPayload(value) {
\tconst action = value.action;
\tconst actionValue = action.value;
\tconst openMessageId = firstString(context.open_message_id, value.open_message_id);
\treturn {
\t\taction: {
\t\t\tvalue: actionValue,
\t\t\ttag
\t\t},
\t};
}`;

const fallbackFixture = `function buildFeishuCardActionTextFallback(event) {
\tconst actionValue = event.action.value;
\tif (isRecord$1(actionValue)) {
\t\tif (typeof actionValue.text === "string") return actionValue.text;
\t\tif (typeof actionValue.command === "string") return actionValue.command;
\t\treturn JSON.stringify(actionValue);
\t}
\treturn String(actionValue);
}`;

test('兼容桥把飞书 form_value 保留到卡片动作对象', () => {
  const patched = patchCardActionParser(parserFixture);
  assert.match(patched, /action\.form_value/);
  assert.match(patched, /form_value: actionFormValue/);
  assert.equal(patchCardActionParser(patched), patched, '重复应用必须幂等');
});

test('兼容桥只给显式 BrainX 表单附加白名单字段', () => {
  const patched = patchCardActionFallback(fallbackFixture);
  assert.match(patched, /actionValue\.brainx_form !== true/);
  assert.match(patched, /formValue\.criteria/);
  assert.match(patched, /formValue\.job_id/);
  assert.match(patched, /trim\(\)\.slice\(0, 2e3\)/);
  assert.match(patched, /trim\(\)\.slice\(0, 128\)/);
  assert.match(patched, /BRAINTEX_CARD_FORM/);
  assert.equal(patchCardActionFallback(patched), patched, '重复应用必须幂等');
});

test('兼容桥遇到未知 OpenClaw 源码形状时拒绝继续', () => {
  assert.throws(() => patchCardActionParser('changed upstream'), /expected exactly one/);
  assert.throws(() => patchCardActionFallback('changed upstream'), /expected exactly one/);
});
