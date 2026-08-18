"""Feishu Bot 通知：新的人类任务生成时推送给猎头/顾问。

优先使用 webhook（配置 TTC_FEISHU_BOT_WEBHOOK）。
未配置 webhook 但配置了 TTC_FEISHU_CHAT_ID 时，使用本地 lark-cli 发送群消息。
"""
import json
import logging
import os
import subprocess
from typing import Any, Dict, Optional

import requests

from .config import FEISHU_BOT_CONFIG

logger = logging.getLogger(__name__)


def _webhook_url() -> Optional[str]:
    return FEISHU_BOT_CONFIG.get("webhook_url", "") or None


def _chat_id() -> Optional[str]:
    return FEISHU_BOT_CONFIG.get("chat_id", "") or None


def _enabled() -> bool:
    return bool(_webhook_url() or _chat_id()) and FEISHU_BOT_CONFIG.get("enabled", False)


def _dashboard_url() -> str:
    return FEISHU_BOT_CONFIG.get("dashboard_url", "http://127.0.0.1:8766")


def _task_url(task: Dict[str, Any]) -> str:
    return _dashboard_url().rstrip("/") + task.get("html_url", f"/human/task/{task['id']}")


def _send_via_cli(text: str) -> bool:
    chat_id = _chat_id()
    if not chat_id:
        return False
    cmd = [
        "lark-cli",
        "im", "+messages-send",
        "--as", "bot",
        "--chat-id", chat_id,
        "--msg-type", "text",
        "--text", text,
    ]
    try:
        env = os.environ.copy()
        env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
        env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
        result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)
        if result.returncode != 0:
            logger.warning("lark-cli send failed: %s", result.stderr or result.stdout)
            return False
        logger.info("Feishu CLI message sent to %s", chat_id)
        return True
    except Exception as e:
        logger.warning("Feishu CLI send error: %s", e)
        return False


def _send_card(card: Dict[str, Any]) -> bool:
    url = _webhook_url()
    if url:
        try:
            resp = requests.post(url, json=card, timeout=15)
            resp.raise_for_status()
            try:
                payload = resp.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict) and "code" in payload and payload.get("code") not in (0, "0"):
                logger.warning("Feishu webhook rejected card: code=%s msg=%s", payload.get("code"), payload.get("msg"))
                return False
            return True
        except Exception as e:
            logger.warning("Feishu webhook failed: %s", e)
            return False

    # Fallback to lark-cli with simple text if chat_id is configured
    text = card.get("card", {}).get("header", {}).get("title", {}).get("content", "TTC 通知")
    elements = card.get("card", {}).get("elements", [])
    for el in elements:
        if el.get("tag") == "div" and "text" in el:
            text += "\n" + el["text"].get("content", "")
    return _send_via_cli(text)


def notify_new_task(task: Dict[str, Any]) -> bool:
    """发送新任务通知到飞书。"""
    if not _enabled():
        return False

    payload = task.get("payload", "{}")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}

    task_type_labels = {
        "call": "📞 打电话",
        "review": "🔍 审核",
        "compliance": "🛡️ 合规",
        "jd_clarify": "❓ JD 澄清",
        "source_help": "🔎 寻访协助",
        "read_failed": "❌ 读取失败",
        "login_required": "🔐 登录受限",
        "classify_uncertain": "📂 分类不确定",
    }
    label = task_type_labels.get(task.get("task_type"), "📝 新任务")
    task_url = _task_url(task)

    # Try webhook card first
    card = {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": f"{label}：{task.get('role', '猎头')}"},
                "template": "blue",
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": f"任务 ID：**{task['id']}**\n类型：**{task.get('task_type', '')}**\n状态：**{task.get('status', '')}**",
                    },
                },
                {"tag": "hr"},
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "打开任务页"},
                            "url": task_url,
                            "type": "primary",
                        }
                    ],
                },
            ],
        },
    }
    if _webhook_url():
        return _send_card(card)

    # Fallback to CLI text
    text = (
        f"{label}\n"
        f"任务 ID：{task['id']}\n"
        f"类型：{task.get('task_type', '')}\n"
        f"状态：{task.get('status', '')}\n"
        f"打开：{task_url}"
    )
    return _send_via_cli(text)


def notify_problem(task: Dict[str, Any], problem: str) -> bool:
    """发送异常任务通知。"""
    if not _enabled():
        return False

    task_url = _task_url(task)
    card = {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": "⚠️ AI 遇到异常，需要人介入"},
                "template": "red",
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": f"问题：{problem[:200]}\n任务 ID：{task['id']}",
                    },
                },
                {"tag": "hr"},
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "处理异常"},
                            "url": task_url,
                            "type": "danger",
                        }
                    ],
                },
            ],
        },
    }
    if _webhook_url():
        return _send_card(card)

    text = f"⚠️ AI 遇到异常\n问题：{problem[:200]}\n任务 ID：{task['id']}\n打开：{task_url}"
    return _send_via_cli(text)
