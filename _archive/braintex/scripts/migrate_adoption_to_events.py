#!/usr/bin/env python3
"""一次性迁移：adoption_events（adopted/ignored 二态）→ decision_events（文档 §4.2 兼容映射）。

旧 adopted → ACCEPTED 事件，旧 ignored → DISMISSED 事件。
幂等键 = migrate:adoption:<request_id>，重复执行安全。
 engagements 投影由 scripts/rebuild_engagements.py 重建。
"""

from decision import _bootstrap  # noqa: F401

import argparse
import json

from decision.db import get_conn
from decision.event_store import MysqlStore, new_event_id

MAPPING = {"adopted": "ACCEPTED", "ignored": "DISMISSED"}


def migrate(store: MysqlStore, rows: list[dict], *, actor: str = "system-migrate") -> dict:
    migrated = skipped = 0
    for row in rows:
        target = MAPPING.get(row.get("event_type", ""))
        if not target:
            skipped += 1
            continue
        detail = row.get("detail_json")
        if isinstance(detail, str):
            try:
                detail = json.loads(detail)
            except ValueError:
                detail = {}
        reason = (detail or {}).get("ignore_reason", "") if target == "DISMISSED" else ""
        consultant = row.get("actor") or row.get("consultant") or "unknown"
        occurred = row.get("created_at")
        event = {
            "event_id": new_event_id(),
            "consultant_id": consultant,
            "opportunity_id": row.get("job_signal_fingerprint", ""),
            "decision_id": row.get("recommendation_id"),
            "event_type": target,
            "previous_state": "",
            "next_state": target,
            "actor": actor,
            "reason_code": reason or ("legacy_ignore" if target == "DISMISSED" else ""),
            "metadata_json": {"source": "legacy_adoption", "legacy_event": row.get("event_type", "")},
            "policy_version": "",
            "occurred_at": occurred,
            "recorded_at": occurred,
            "idempotency_key": f"migrate:adoption:{row['request_id']}",
        }
        _stored, created = store.append_event(event)
        migrated += 1 if created else 0
        skipped += 0 if created else 1
    return {"migrated": migrated, "skipped": skipped}


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate adoption_events into decision_events")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT a.recommendation_id, a.request_id, a.event_type, a.actor, a.detail_json, "
                "a.created_at, r.job_signal_fingerprint, r.consultant "
                "FROM adoption_events a LEFT JOIN recommendations r ON r.id = a.recommendation_id"
            )
            rows = cur.fetchall() or []
            cols = [d[0] for d in getattr(cur, "description", None) or []]
            dicts = [dict(zip(cols, r)) if not isinstance(r, dict) else dict(r) for r in rows]
            if args.dry_run:
                print(f"adoption_events 共 {len(dicts)} 行，映射规则 {MAPPING}")
                return 0
            result = migrate(MysqlStore(cur), dicts)
        conn.commit()
    print("迁移完成：", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
