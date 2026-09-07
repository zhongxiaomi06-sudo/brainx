/** 把 BrainTex 动态创建的项目群追加到 OpenClaw 飞书群白名单；串行读改写避免并发丢群。 */
import { createOpenClawRunner, PersonalModelError } from './personal-model-config.js';

function fail(code, cause) {
  throw new PersonalModelError(code, cause ? { cause } : {});
}

function parseGroupList(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      fail('OPENCLAW_GROUP_CONFIG_INVALID');
    }
    return parsed;
  } catch (error) {
    if (error instanceof PersonalModelError) throw error;
    fail('OPENCLAW_GROUP_CONFIG_INVALID', error);
  }
}

export function createOpenClawGroupAccess(options = {}) {
  const cli = options.cli || createOpenClawRunner(options);
  let queue = Promise.resolve();

  const apply = async (chatId) => {
    if (!/^oc_[A-Za-z0-9_-]+$/.test(String(chatId || ''))) fail('OPENCLAW_GROUP_ID_INVALID');
    let current;
    try {
      current = parseGroupList((await cli.call([
        'config', 'get', 'channels.feishu.groupAllowFrom', '--json',
      ])).stdout);
    } catch (error) {
      if (error instanceof PersonalModelError && error.code === 'OPENCLAW_GROUP_CONFIG_INVALID') throw error;
      fail('OPENCLAW_GROUP_ALLOWLIST_FAILED', error);
    }
    if (current.includes(chatId)) return { chat_id: chatId, added: false, count: current.length };
    const next = [...new Set([...current, chatId])].sort();
    try {
      await cli.call(['config', 'set', 'channels.feishu.groupAllowFrom', JSON.stringify(next),
        '--strict-json', '--replace']);
    } catch (error) { fail('OPENCLAW_GROUP_ALLOWLIST_FAILED', error); }
    return { chat_id: chatId, added: true, count: next.length };
  };

  return {
    ensure(chatId) {
      const task = queue.then(() => apply(chatId));
      queue = task.catch(() => {});
      return task;
    },
  };
}

const defaultAccess = createOpenClawGroupAccess();
export const ensureOpenClawProjectGroup = (chatId) => defaultAccess.ensure(chatId);
