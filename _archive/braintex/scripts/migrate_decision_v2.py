#!/usr/bin/env python3
"""One-shot migration for the v2 decision tables (dev doc v2.0 §9).

另含 S2 的 recommendations 加列（MySQL 8 无 ADD COLUMN IF NOT EXISTS，
先查 information_schema.COLUMNS 再逐个补列，幂等可重跑）。
"""

from decision import _bootstrap  # noqa: F401

from pathlib import Path

from decision.db import get_conn

RECOMMENDATIONS_V2_COLUMNS = [
    ("action", "VARCHAR(24) NOT NULL DEFAULT ''"),
    ("confidence_band", "VARCHAR(8) NOT NULL DEFAULT ''"),
    ("evidence_coverage", "DOUBLE NOT NULL DEFAULT 0"),
    ("policy_version", "VARCHAR(40) NOT NULL DEFAULT ''"),
]


def ensure_recommendations_columns(cur) -> list[str]:
    cur.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recommendations'"
    )
    existing = {row[0] if not isinstance(row, dict) else row["COLUMN_NAME"] for row in cur.fetchall()}
    added = []
    for name, definition in RECOMMENDATIONS_V2_COLUMNS:
        if name in existing:
            continue
        cur.execute(f"ALTER TABLE recommendations ADD COLUMN {name} {definition}")
        added.append(name)
    return added


def main() -> int:
    schema = Path(__file__).resolve().parents[1] / "decision" / "schema_v2.sql"
    if not schema.exists():
        raise SystemExit(f"schema 文件不存在：{schema}")
    statements = [s.strip() for s in schema.read_text(encoding="utf-8").split(";") if s.strip() and "CREATE TABLE" in s]
    with get_conn() as conn:
        with conn.cursor() as cur:
            for statement in statements:
                cur.execute(statement)
            added = ensure_recommendations_columns(cur)
            cur.execute("SHOW TABLES")
            tables = sorted(row[0] for row in cur.fetchall())
        conn.commit()
    print("decision v2 schema ready:", tables)
    print("recommendations 新增列:", added or "（已存在，无变更）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
