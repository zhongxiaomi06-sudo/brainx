#!/usr/bin/env python3
"""Explicit, one-shot migration for the Brian X decision tables."""

from decision import _bootstrap  # noqa: F401

from pathlib import Path

from decision.db import get_conn


def main() -> int:
    # braintex 独立项目布局：schema 在 <root>/decision/schema.sql
    schema = Path(__file__).resolve().parents[1] / "decision" / "schema.sql"
    if not schema.exists():
        raise SystemExit(f"schema 文件不存在：{schema}")
    statements = [statement.strip() for statement in schema.read_text(encoding="utf-8").split(";") if statement.strip()]
    with get_conn() as conn:
        with conn.cursor() as cur:
            for statement in statements:
                cur.execute(statement)
            cur.execute("SHOW TABLES")
            tables = cur.fetchall()
        conn.commit()
    print("decision schema ready:", tables)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
