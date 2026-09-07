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

  const readList = async (path) => {
    try {
      return parseGroupList((await cli.call(['config', 'get', path, '--json'])).stdout);
    } catch (error) {
      if (error instanceof PersonalModelError && error.code === 'OPENCLAW_GROUP_CONFIG_INVALID') throw error;
      fail('OPENCLAW_GROUP_ALLOWLIST_FAILED', error);
    }
  };

  const appendList = async (path, current, values) => {
    const next = [...new Set([...current, ...values])].sort();
    if (next.length === current.length) return { added: 0, count: current.length };
    try {
      await cli.call(['config', 'set', path, JSON.stringify(next), '--strict-json', '--replace']);
    } catch (error) { fail('OPENCLAW_GROUP_ALLOWLIST_FAILED', error); }
    return { added: next.length - current.length, count: next.length };
  };

  const apply = async (chatId, senderOpenIds = []) => {
    if (!/^oc_[A-Za-z0-9_-]+$/.test(String(chatId || ''))) fail('OPENCLAW_GROUP_ID_INVALID');
    const senders = [...new Set(senderOpenIds)];
    if (senders.some((value) => !/^ou_[A-Za-z0-9_-]+$/.test(String(value || '')))) {
      fail('OPENCLAW_GROUP_SENDER_INVALID');
    }
    const groups = await readList('channels.feishu.groupAllowFrom');
    const groupResult = await appendList('channels.feishu.groupAllowFrom', groups, [chatId]);
    const currentSenders = await readList('channels.feishu.groupSenderAllowFrom');
    const senderResult = await appendList('channels.feishu.groupSenderAllowFrom', currentSenders, senders);
    return { chat_id: chatId, added: groupResult.added > 0, count: groupResult.count,
      sender_added: senderResult.added, sender_count: senderResult.count };
  };

  return {
    ensure(chatId, senderOpenIds) {
      const task = queue.then(() => apply(chatId, senderOpenIds));
      queue = task.catch(() => {});
      return task;
    },
  };
}

const defaultAccess = createOpenClawGroupAccess();
export const ensureOpenClawProjectGroup = (chatId, senderOpenIds) => defaultAccess.ensure(chatId, senderOpenIds);
