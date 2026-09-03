import { body, err, json } from './server-http.js';
import { cookieOf, verifySession } from './session.js';
import { createPersonalModelService, PersonalModelError } from './personal-model-config.js';

const STATUS = {
  MODEL_CONFIG_DISABLED: 503,
  MODEL_CONSENT_REQUIRED: 422,
  MODEL_INPUT_INVALID: 422,
  MODEL_PROVIDER_INVALID: 422,
  MODEL_ID_INVALID: 422,
  MODEL_KEY_INVALID: 422,
  PERSONAL_AGENT_NOT_READY: 409,
  MODEL_CONFIG_BUSY: 409,
  OPENCLAW_UNAVAILABLE: 503,
  OPENCLAW_TIMEOUT: 503,
  OPENCLAW_OUTPUT_LIMIT: 503,
  OPENCLAW_COMMAND_FAILED: 502,
  MODEL_CONFIG_FAILED: 502,
  MODEL_ROLLBACK_FAILED: 500,
};

const MESSAGES = {
  MODEL_CONFIG_DISABLED: '个人模型配置尚未开放',
  MODEL_CONSENT_REQUIRED: '请先确认模型供应商会处理本次对话中的必要数据',
  MODEL_INPUT_INVALID: '配置内容不合法',
  MODEL_PROVIDER_INVALID: '请选择支持的模型供应商',
  MODEL_ID_INVALID: '模型名称格式不合法',
  MODEL_KEY_INVALID: 'API Key 格式不合法',
  PERSONAL_AGENT_NOT_READY: '请先在飞书私聊机器人发送一条消息，再返回配置',
  MODEL_CONFIG_BUSY: '你的模型配置正在更新，请稍后重试',
  OPENCLAW_UNAVAILABLE: '个人 Agent 暂时不可用',
  OPENCLAW_TIMEOUT: '个人 Agent 配置超时，请稍后重试',
  OPENCLAW_OUTPUT_LIMIT: '个人 Agent 返回异常，请联系管理员',
  OPENCLAW_COMMAND_FAILED: '模型配置未成功，请检查模型名称和密钥',
  MODEL_CONFIG_FAILED: '模型配置未成功，原设置已保留',
  MODEL_ROLLBACK_FAILED: '配置恢复失败，请联系管理员',
};

function identity(req, consultantId) {
  const session = verifySession(cookieOf(req));
  if (!session || session.consultant_id !== consultantId || !session.open_id) {
    throw new PersonalModelError('UNAUTHORIZED');
  }
  return { consultantId, openId: session.open_id };
}

function sendError(res, error) {
  const code = error instanceof PersonalModelError ? error.code : 'MODEL_CONFIG_FAILED';
  if (code === 'UNAUTHORIZED') return err(res, 401, code, '请使用飞书账号重新登录');
  return err(res, STATUS[code] || 500, code, MESSAGES[code] || MESSAGES.MODEL_CONFIG_FAILED);
}

export function personalModelRoutes(db, options = {}) {
  const service = options.personalModelService || createPersonalModelService({ db, ...options });
  const admins = options.personalModelAdmins
    || String(process.env.BRAINX_AGENT_ADMIN_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    'GET /api/v1/model-profile': async (req, res, consultantId) => {
      try { json(res, 200, await service.getStatus(identity(req, consultantId))); }
      catch (error) { sendError(res, error); }
    },
    'PUT /api/v1/model-profile': async (req, res, consultantId) => {
      try {
        if (Number(req.headers['content-length'] || 0) > 4096) {
          return err(res, 413, 'MODEL_INPUT_TOO_LARGE', '配置内容超过 4 KiB');
        }
        const input = await body(req);
        if (!input || Buffer.byteLength(JSON.stringify(input), 'utf8') > 4096) {
          return err(res, 413, 'MODEL_INPUT_TOO_LARGE', '配置内容超过 4 KiB');
        }
        json(res, 200, await service.configure(identity(req, consultantId), input));
      } catch (error) { sendError(res, error); }
    },
    'DELETE /api/v1/model-profile': async (req, res, consultantId) => {
      try { json(res, 200, await service.disable(identity(req, consultantId))); }
      catch (error) { sendError(res, error); }
    },
    'GET /api/v1/admin/model-profiles': (req, res, consultantId) => {
      if (!admins.includes(consultantId)) return err(res, 403, 'ADMIN_FORBIDDEN', '无管理员权限');
      const items = db.prepare(`SELECT c.consultant_id,c.display_name,p.agent_id,p.provider_id,
        p.model_id,p.status,p.configured_at,p.updated_at
        FROM consultants c LEFT JOIN consultant_model_profiles p USING(consultant_id)
        WHERE c.active=1 ORDER BY c.consultant_id`).all();
      json(res, 200, { schema_version: 'personal_model_readiness.v1', items });
    },
  };
}
