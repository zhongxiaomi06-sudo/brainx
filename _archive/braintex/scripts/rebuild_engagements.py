#!/usr/bin/env python3
"""engagements 投影重建（文档 §9 投影原则）：engagements 损坏时由 decision_events 重建。

默认全量重建（逐 (consultant, opportunity) upsert）；--consultant 只重建单顾问。
只写投影表，不动事件账本。
"""

from decision import _bootstrap  # noqa: F401

import argparse

from decision.db import get_conn
from decision.event_store import MysqlStore, rebuild_projection


def rebuild(store: MysqlStore, consultant_id: str | None = None) -> dict:
    projection = rebuild_projection(store, consultant_id)
    for row in projection.values():
        store.upsert_engagement(row)
    return {"rebuilt": len(projection), "consultant": consultant_id or "*"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild engagements projection from decision_events")
    parser.add_argument("--consultant", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    with get_conn() as conn:
        with conn.cursor() as cur:
            store = MysqlStore(cur)
            if args.dry_run:
                projection = rebuild_projection(store, args.consultant or None)
                for key, row in sorted(projection.items()):
                    print(key, "→", row["state"], f"v{row['state_version']}")
                print(f"共 {len(projection)} 条投影（dry-run 未写入）")
                return 0
            result = rebuild(store, args.consultant or None)
        conn.commit()
    print("投影重建完成：", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
