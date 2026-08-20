"""Small database boundary for the Brian X decision workflow.

No caller outside this package should talk to RDS.  The preferred connector is
the existing ``cloud_sync.client.get_conn``; the lazy fallback keeps local
unit tests importable in a checkout where that optional package is absent.
"""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import json
import os
from contextlib import contextmanager
from typing import Any, Iterator

SEED_WEIGHTS = {
    "freshness": 0.25,
    "salary_fit": 0.20,
    "urgency": 0.20,
    "supply_match": 0.25,
    "client_history": 0.10,
}


@contextmanager
def get_conn() -> Iterator[Any]:
    """Yield the configured MySQL connection without importing it at startup."""
    try:
        from cloud_sync.client import get_conn as existing_get_conn
    except ImportError:
        try:
            import pymysql
        except ImportError as exc:  # pragma: no cover - deployment dependency
            raise RuntimeError("RDS 连接依赖缺失：请安装 pymysql 或提供 cloud_sync.client") from exc
        host = os.getenv("RDS_HOST", "")
        if not all((host, os.getenv("RDS_USER", ""), os.getenv("RDS_PASSWORD", ""))):
            raise RuntimeError("RDS 配置缺失：请设置 RDS_HOST、RDS_USER、RDS_PASSWORD")
        conn = pymysql.connect(
            host=host,
            port=int(os.getenv("RDS_PORT", "3306")),
            user=os.getenv("RDS_USER"),
            password=os.getenv("RDS_PASSWORD"),
            database=os.getenv("RDS_DB", "ttc_talent"),
            charset="utf8mb4",
            autocommit=False,
        )
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return
    with existing_get_conn() as conn:
        yield conn


def _value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return row[index]


def current_weights(seed: bool = True) -> dict[str, Any]:
    """Read the newest version, seeding version 1 only on explicit invocation."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT version, weights_json FROM weight_config "
                "ORDER BY version DESC LIMIT 1"
            )
            row = cur.fetchone()
            if row:
                raw = _value(row, "weights_json", 1)
                weights = json.loads(raw) if isinstance(raw, str) else raw
                return {"version": int(_value(row, "version", 0)), "weights": weights}
            if not seed:
                return {"version": 1, "weights": dict(SEED_WEIGHTS)}
            payload = json.dumps(SEED_WEIGHTS, ensure_ascii=False)
            cur.execute(
                "INSERT INTO weight_config "
                "(version, weights_json, change_source, change_note) "
                "VALUES (%s, %s, 'seed', 'initial seed')",
                (1, payload),
            )
        conn.commit()
    return {"version": 1, "weights": dict(SEED_WEIGHTS)}
