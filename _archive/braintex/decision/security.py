"""HMAC links for recommendation actions."""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import hashlib
import hmac
import os
from datetime import date, datetime
from typing import Any

from decision import db


def _secret() -> str:
    value = os.getenv("TTC_DECISION_HMAC_SECRET", "")
    if not value:
        raise RuntimeError("TTC_DECISION_HMAC_SECRET 未配置")
    return value


def make_token(rec_id: int, rec_date: str | date | datetime) -> str:
    iso = rec_date.isoformat()[:10] if hasattr(rec_date, "isoformat") else str(rec_date)[:10]
    message = f"{int(rec_id)}|{iso}"
    signature = hmac.new(_secret().encode(), message.encode(), hashlib.sha256).hexdigest()[:24]
    return f"{int(rec_id)}.{signature}"


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return row[index]


def verify_token(token: str) -> int:
    try:
        rec_text, supplied = str(token).split(".", 1)
    except (AttributeError, ValueError):
        raise ValueError("无效token") from None
    if not rec_text.isdigit() or len(supplied) != 24:
        raise ValueError("无效token")
    rec_id = int(rec_text)
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT rec_date FROM recommendations WHERE id=%s", (rec_id,))
            row = cur.fetchone()
    if not row:
        raise ValueError("无效token")
    expected = make_token(rec_id, _row_value(row, "rec_date", 0)).split(".", 1)[1]
    if not hmac.compare_digest(expected, supplied):
        raise ValueError("无效token")
    return rec_id
