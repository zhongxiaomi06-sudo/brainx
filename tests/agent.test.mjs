/** agent loop 与 chat 路由测试:剧本化 chatCompletionFn(队列出答案),手写 req/res 假对象。
 * 不 mock fetch、不触网;BRAINX_LLM_DISABLE 隔离本地 .env 的真实 key。
 * 注意:env 必须在动态导入被测模块前设置(静态 import 提升会让赋值晚于模块加载)。 */
process.env.BRAINX_LLM_DISABLE = '1';
process.env.BRAINX_AGENT_MAX_ROUNDS = '3';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { openDb } = await import('../src/db.js');
const { runSync } = await import('../src/sync.js');
const { assistantRoutes } = await import('../src/assistant-routes.js');

const request = (payload, signal) => ({
  signal,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); },
});
const response = () => ({
  status: 0, text: '', destroyed: false,
  writeHead(status) { this.status = status; },
  write(chunk = '') { this.text += String(chunk); },
  end(chunk = '') { this.text += String(chunk); },
});

/** 把 SSE 文本解析成帧数组 {event, data}。 */
const frames = (text) => text.split('\n\n').filter(Boolean).map((block) => {
  const event = block.match(/^event: (.+)$/m)?.[1] || 'message';
  const dataLine = block.match(/^data: (.*)$/m)?.[1] || '{}';
  let data = null;
  try { data = JSON.parse(dataLine); } catch { /* 保留 null */ }
  return { event, data };
});

/** 剧本化 chatCompletionFn:队列依次出;每个元素 {content?, toolCalls?} 或函数(messages)。 */
const scripted = (queue) => {
  const calls = [];
  const fn = async (messages, opts) => {
    calls.push(messages);
    fn.opts.push(opts);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(messages) : next;
  };
  fn.calls = calls;
  fn.opts = [];
  return fn;
};

const makeRoutes = (db, chatCompletionFn) => assistantRoutes(db, {
  isLlmConfiguredFn: () => true,
  chatCompletionFn,
  skillsIndex: new Map(),
});

const ask = async (routes, question, { signal, cid = 'felix' } = {}) => {
  const res = response();
  await routes['POST /api/v1/assistant/chat'](
    request({ question, history: [], context: { page: 'today' } }, signal), res, cid);
  return res;
};

test('直答:帧序 meta → text* → done,文本拼接还原', async () => {
  const routes = makeRoutes(openDb(':memory:'), scripted([{ content: '你好,这是回答。' }]));
  const res = response();
  await routes['POST /api/v1/assistant/chat'](
    request({ question: '打个招呼', history: [] }), res, 'felix');
  assert.equal(res.status, 200);
  const fr = frames(res.text);
  assert.equal(fr[0].event, 'meta');
  assert.equal(fr[0].data.agent, true);
  assert.equal(typeof fr[0].data.tools, 'number');
  const text = fr.filter((f) => f.data?.text).map((f) => f.data.text).join('');
  assert.equal(text, '你好,这是回答。');
  const done = fr.find((f) => f.event === 'done');
  assert.deepEqual(done.data, { rounds: 1, tool_calls: 0 });
});

test('单工具轮:真执行 roster 查询,tool 帧无 text/message 键', async () => {
  const chatFn = scripted([
    { content: '', toolCalls: [{ id: 't1', name: 'brainx_consultants', arguments: {} }] },
    { content: '花名册里有 felix 等顾问。' },
  ]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  const res = response();
  await routes['POST /api/v1/assistant/chat'](request({ question: '有哪些顾问?' }), res, 'felix');
  const fr = frames(res.text);
  const toolFrames = fr.filter((f) => f.event === 'tool');
  assert.equal(toolFrames.length, 2); // start + ok
  for (const f of toolFrames) {
    assert.equal(f.data.tool, 'brainx_consultants');
    assert.ok(!('text' in f.data) && !('message' in f.data)); // 防前端误渲染
  }
  // 第二轮模型拿到的 messages 含 role:tool 且带 roster 种子数据
  const second = chatFn.calls[1];
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 't1');
  assert.match(toolMsg.content, /felix/);
  assert.equal(fr.find((f) => f.event === 'done').data.tool_calls, 1);
});

test('一轮多个 tool_calls:顺序执行,每个 id 都有 tool 消息应答', async () => {
  const chatFn = scripted([
    { content: '', toolCalls: [
      { id: 'a', name: 'brainx_consultants', arguments: {} },
      { id: 'b', name: 'brainx_profile', arguments: {} },
    ] },
    { content: '都查到了。' },
  ]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  await routes['POST /api/v1/assistant/chat'](request({ question: '查两个' }), response(), 'felix');
  const second = chatFn.calls[1];
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['a', 'b']);
  const assistantMsg = second.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistantMsg.tool_calls.length, 2);
  assert.equal(typeof assistantMsg.tool_calls[0].function.arguments, 'string');
});

test('maxRounds 耗尽:无工具强制收尾轮,仍出 done', async () => {
  // 环境 BRAINX_AGENT_MAX_ROUNDS=3(文件头):3 轮工具轮后第 4 轮无 tools
  const tc = () => ({ content: '', toolCalls: [{ id: 'x', name: 'brainx_consultants', arguments: {} }] });
  const chatFn = scripted([tc(), tc(), tc(), { content: '被迫收尾的答案。' }]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  const res = response();
  await routes['POST /api/v1/assistant/chat'](request({ question: '无限循环' }), res, 'felix');
  const fr = frames(res.text);
  const done = fr.find((f) => f.event === 'done');
  assert.equal(done.data.rounds, 4); // 3 工具轮 + 1 收尾轮
  assert.equal(fr.filter((f) => f.data?.text).map((f) => f.data.text).join(''), '被迫收尾的答案。');
  // 收尾轮请求不带 tools
  assert.equal(chatFn.opts[3]?.tools, undefined);
});

test('坏 arguments JSON:工具回 BAD_ARGUMENTS,loop 续跑', async () => {
  const chatFn = scripted([
    { content: '', toolCalls: [{ id: 't1', name: 'brainx_consultants', arguments: { __parseError: '{broken' } }] },
    { content: '参数坏了但我还在。' },
  ]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  await routes['POST /api/v1/assistant/chat'](request({ question: '测坏参数' }), response(), 'felix');
  const toolMsg = chatFn.calls[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /BAD_ARGUMENTS/);
});

test('未知工具名:工具回 UNKNOWN_TOOL,loop 续跑', async () => {
  const chatFn = scripted([
    { content: '', toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: {} }] },
    { content: '换用已知信息回答。' },
  ]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  await routes['POST /api/v1/assistant/chat'](request({ question: '测未知工具' }), response(), 'felix');
  const toolMsg = chatFn.calls[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /UNKNOWN_TOOL/);
});

test('并发闸:同顾问第二问 429 AGENT_BUSY,释放后恢复', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chatFn = scripted([
    async () => { await gate; return { content: '第一问完成。' }; },
    { content: '第三问完成。' },
  ]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  const first = ask(routes, '第一问');
  await new Promise((r) => setImmediate(r)); // 让第一问进入 agent
  const res2 = response();
  await routes['POST /api/v1/assistant/chat'](request({ question: '第二问' }), res2, 'felix');
  assert.equal(res2.status, 429);
  assert.equal(JSON.parse(res2.text).error.code, 'AGENT_BUSY');
  release();
  const res1 = await first;
  assert.equal(res1.status, 200);
  const res3 = await ask(routes, '第三问');
  assert.equal(res3.status, 200);
});

test('503 未配置与 422 校验保持', async () => {
  const routes503 = assistantRoutes(openDb(':memory:'), { isLlmConfiguredFn: () => false });
  const res = response();
  await routes503['POST /api/v1/assistant/chat'](request({ question: 'hi' }), res, 'felix');
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.text).error.code, 'LLM_NOT_CONFIGURED');
  const routes = makeRoutes(openDb(':memory:'), scripted([{ content: 'x' }]));
  const res422 = response();
  await routes['POST /api/v1/assistant/chat'](request({ question: '' }), res422, 'felix');
  assert.equal(res422.status, 422);
});

test('客户端中止:信号中断后 error 帧收尾,闸释放可再问', async () => {
  const ctrl = new AbortController();
  const chatFn = scripted([
    async () => { ctrl.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    { content: '恢复后的回答。' },
  ]);
  const routes = makeRoutes(openDb(':memory:'), chatFn);
  const res = response();
  await routes['POST /api/v1/assistant/chat'](
    request({ question: '会被中断' }, ctrl.signal), res, 'felix');
  assert.equal(frames(res.text).at(-1).event, 'error');
  const res2 = await ask(routes, '再问一次'); // 闸已释放
  assert.equal(res2.status, 200);
});

test('真实工具全链路:fixture 同步后 agent 用 workbench 答 Top3', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const chatFn = scripted([
    { content: '', toolCalls: [{ id: 'w', name: 'brainx_workbench', arguments: {} }] },
    (messages) => {
      const toolMsg = messages.find((m) => m.role === 'tool');
      const data = JSON.parse(toolMsg.content);
      assert.equal(data.consultant_id, 'felix');
      assert.equal(data.sync.state, 'READY');
      return { content: `同步就绪,Top3 共 ${data.today_top3.length} 条。` };
    },
  ]);
  const routes = makeRoutes(db, chatFn);
  const res = response();
  await routes['POST /api/v1/assistant/chat'](request({ question: '今天状态?' }), res, 'felix');
  assert.match(res.text, /同步就绪/);
});
