/** index.js — createAgent:把 db/skills/llm/工具注册表组装成一次会话问答的入口。
 * 每请求新建 toolkit(cid 归属),技能索引进程级缓存,只读 SQL 句柄懒开单例。 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db.js';
import { chatCompletion } from '../llm.js';
import { latestSync } from '../sync.js';
import { loadConsultants } from '../recommend.js';
import { createToolkit } from './registry.js';
import { discoverSkills } from './skills.js';
import { buildSystemPrompt } from './persona.js';
import { runAgentLoop } from './loop.js';

export function createAgent({ db, deps = {} }) {
  const chatFn = deps.chatCompletionFn || chatCompletion;
  let skillIndexCache = deps.skillsIndex || null;
  const skillsIndex = () => (skillIndexCache ||= discoverSkills());
  let readDbHandle = null;
  const readDb = deps.readDb || (() => {
    if (!readDbHandle) readDbHandle = new DatabaseSync(DB_PATH, { readOnly: true });
    return readDbHandle;
  });

  return {
    /** meta 帧用:当前注册的工具数(不依赖请求上下文)。 */
    describe() {
      return { toolCount: createToolkit({ db, cid: null, skillsIndex: null, readDb }).toolCount };
    },

    /** 一轮问答:persona + 历史 + 问题 → agent loop → { text, rounds, toolCalls, usage }。 */
    async chat({ cid, question, history = [], context = {}, signal, onTool }) {
      const index = skillsIndex();
      const toolkit = createToolkit({ db, cid, skillsIndex: index, readDb });
      const displayName = loadConsultants(db).find((c) => c.consultant_id === cid)?.display_name;
      const sync = latestSync(db, cid);
      const system = buildSystemPrompt({
        cid, displayName, skillIndex: index,
        context: { ...context, sync_state: sync ? (sync.complete ? 'READY' : 'INCOMPLETE') : 'EMPTY' },
      });
      const messages = [
        { role: 'system', content: system },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: question },
      ];
      return runAgentLoop({
        messages, tools: toolkit.schemas, callTool: toolkit.call, chatFn, onTool, signal,
      });
    },
  };
}
