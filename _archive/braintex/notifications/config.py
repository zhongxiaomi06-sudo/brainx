"""Feishu bot notification config (standalone braintex project).

Mirrors the relevant slice of the legacy ttc_daemon.config; all values come
from environment variables, never hardcoded.
"""
import os

FEISHU_BOT_CONFIG = {
    "webhook_url": os.getenv("TTC_FEISHU_BOT_WEBHOOK", ""),
    "chat_id": os.getenv("TTC_FEISHU_CHAT_ID", ""),
    "enabled": os.getenv("TTC_FEISHU_NOTIFY_ENABLED", "false").lower() == "true",
    "dashboard_url": os.getenv("TTC_DASHBOARD_URL", "http://127.0.0.1:8766"),
}
