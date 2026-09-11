import assert from 'node:assert/strict';
import test from 'node:test';

import { patchExternalDispatcherReplyHook } from '../deploy/openclaw/patch-reply-payload-hook.mjs';

const fixture = `async function dispatchReplyFromConfig(params) {
\tconst { ctx, cfg, dispatcher } = params;
\tif (params.replyOptions?.abortSignal?.aborted) return {};
}`;

test('外部渠道 dispatcher 也安装最终回复卡片钩子', () => {
  const patched = patchExternalDispatcherReplyHook(fixture);
  assert.match(patched, /installReplyPayloadSendingBeforeDeliver\(dispatcher, ctx/);
  assert.match(patched, /BRAINX_EXTERNAL_DISPATCH_REPLY_HOOK_V1/);
  assert.equal(patchExternalDispatcherReplyHook(patched), patched, '重复应用必须幂等');
});

test('OpenClaw 源码形状漂移时拒绝继续', () => {
  assert.throws(() => patchExternalDispatcherReplyHook('changed upstream'), /expected exactly one/);
});
