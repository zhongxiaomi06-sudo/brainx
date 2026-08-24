"""事件账本存储（开发文档 v2.0 §7/§9）。

决策事件只追加不改历史；幂等键 UNIQUE，重复提交返回原事件。
``MysqlStore`` 走 RDS（pymysql cursor），``MemoryStore`` 供单元测试与离线回放；
两者同一接口，命令服务不感知差异。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Protocol

EVENT_COLUMNS = (
    "event_id", "consultant_id", "opportunity_id", "decision_id", "event_type",
    "previous_state", "next_state", "actor", "reason_code", "metadata_json",
    "policy_version", "occurred_at", "recorded_at", "idempotency_key",
)


def new_event_id() -> str:
    return uuid.uuid4().hex[:32]


def make_idempotency_key(*parts: Any) -> str:
    """客户端幂等键兜底：命令+对象+日期哈希。生产上以前端/调用方生成优先。"""
    raw = ":".join(str(p) for p in parts)
    return uuid.uuid5(uuid.NAMESPACE_URL, raw).hex[:32]


class Store(Protocol):
    """命令服务依赖的最小存储接口。"""

    def get_engagement(self, consultant_id: str, opportunity_id: str) -> dict | None: ...
    def upsert_engagement(self, row: dict) -> None: ...
    def watched_count(self, consultant_id: str) -> int: ...
    def append_event(self, event: dict) -> tuple[dict, bool]: ...
    def event_by_idempotency(self, key: str) -> dict | None: ...
    def list_events(self, consultant_id: str, opportunity_id: str) -> list[dict]: ...
    def list_engagements(self, consultant_id: str) -> list[dict]: ...
    def all_events(self) -> list[dict]: ...
    def consultant_events(self, consultant_id: str) -> list[dict]: ...
    def append_outcome(self, outcome: dict) -> tuple[dict, bool]: ...
    def outcome_by_idempotency(self, key: str) -> dict | None: ...
    def consultant_outcomes(self, consultant_id: str) -> list[dict]: ...
    def outcome_events_for(self, consultant_id: str, opportunity_id: str) -> list[dict]: ...
    def save_policy(self, policy: dict) -> None: ...
    def list_policies(self, consultant_id: str, kind: str = "", status: str = "") -> list[dict]: ...
    def set_policy_status(self, policy_version: str, status: str, rollback_reason: str = "") -> None: ...


def _dump_json(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value or {}, ensure_ascii=False)


def _row(cols: list[str], row: Any, json_fields: tuple[str, ...] = ("metadata_json", "value_json")) -> dict:
    """行规整：tuple→dict，JSON 列字符串→对象（pymysql JSON 列返回 str）。"""
    data = dict(zip(cols, row)) if not isinstance(row, dict) else dict(row)
    for field in json_fields:
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            try:
                data[field] = json.loads(value)
            except ValueError:
                pass
    return data


class MysqlStore:
    """RDS 实现：decision_events 只追加，engagements 是可重建投影。"""

    def __init__(self, cur: Any):
        self.cur = cur

    def get_engagement(self, consultant_id: str, opportunity_id: str) -> dict | None:
        self.cur.execute(
            "SELECT * FROM engagements WHERE consultant_id=%s AND opportunity_id=%s",
            (consultant_id, opportunity_id),
        )
        row = self.cur.fetchone()
        if not row:
            return None
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return _row(cols, row)

    def upsert_engagement(self, row: dict) -> None:
        self.cur.execute(
            "INSERT INTO engagements "
            "(consultant_id, opportunity_id, state, state_version, last_event_id, "
            "last_action_at, expires_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
            "ON DUPLICATE KEY UPDATE state=VALUES(state), state_version=VALUES(state_version), "
            "last_event_id=VALUES(last_event_id), last_action_at=VALUES(last_action_at), "
            "expires_at=VALUES(expires_at), updated_at=VALUES(updated_at)",
            (
                row["consultant_id"], row["opportunity_id"], row["state"],
                row["state_version"], row["last_event_id"], row["last_action_at"],
                row.get("expires_at"), row["updated_at"],
            ),
        )

    def watched_count(self, consultant_id: str) -> int:
        self.cur.execute(
            "SELECT COUNT(*) FROM engagements WHERE consultant_id=%s AND state='WATCHED'",
            (consultant_id,),
        )
        row = self.cur.fetchone()
        return int(row[0] if not isinstance(row, dict) else next(iter(row.values())))

    def append_event(self, event: dict) -> tuple[dict, bool]:
        existing = self.event_by_idempotency(event["idempotency_key"])
        if existing:
            return existing, False
        self.cur.execute(
            "INSERT INTO decision_events "
            "(event_id, consultant_id, opportunity_id, decision_id, event_type, "
            "previous_state, next_state, actor, reason_code, metadata_json, "
            "policy_version, occurred_at, recorded_at, idempotency_key) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                event["event_id"], event["consultant_id"], event["opportunity_id"],
                event.get("decision_id"), event["event_type"], event.get("previous_state", ""),
                event.get("next_state", ""), event["actor"], event.get("reason_code", ""),
                _dump_json(event.get("metadata_json") or event.get("metadata")),
                event.get("policy_version", ""), event["occurred_at"], event["recorded_at"],
                event["idempotency_key"],
            ),
        )
        return event, True

    def event_by_idempotency(self, key: str) -> dict | None:
        self.cur.execute("SELECT * FROM decision_events WHERE idempotency_key=%s", (key,))
        row = self.cur.fetchone()
        if not row:
            return None
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return _row(cols, row)

    def list_events(self, consultant_id: str, opportunity_id: str) -> list[dict]:
        self.cur.execute(
            "SELECT * FROM decision_events WHERE consultant_id=%s AND opportunity_id=%s "
            "ORDER BY seq",
            (consultant_id, opportunity_id),
        )
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r) for r in rows]

    def list_engagements(self, consultant_id: str) -> list[dict]:
        self.cur.execute(
            "SELECT * FROM engagements WHERE consultant_id=%s ORDER BY updated_at DESC",
            (consultant_id,),
        )
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r) for r in rows]

    def all_events(self) -> list[dict]:
        self.cur.execute("SELECT * FROM decision_events ORDER BY seq")
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r) for r in rows]

    def consultant_events(self, consultant_id: str) -> list[dict]:
        self.cur.execute(
            "SELECT * FROM decision_events WHERE consultant_id=%s ORDER BY seq",
            (consultant_id,),
        )
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r) for r in rows]

    def append_outcome(self, outcome: dict) -> tuple[dict, bool]:
        existing = self.outcome_by_idempotency(outcome["idempotency_key"])
        if existing:
            return existing, False
        self.cur.execute(
            "INSERT INTO outcome_observations "
            "(outcome_id, consultant_id, opportunity_id, scope, source, stage, value_json, "
            "recorded_by, idempotency_key, observed_at, recorded_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                outcome["outcome_id"], outcome["consultant_id"], outcome["opportunity_id"],
                outcome["scope"], outcome["source"], outcome.get("stage", ""),
                _dump_json(outcome.get("value_json") or outcome.get("value")),
                outcome["recorded_by"], outcome["idempotency_key"],
                outcome["observed_at"], outcome["recorded_at"],
            ),
        )
        return outcome, True

    def outcome_by_idempotency(self, key: str) -> dict | None:
        self.cur.execute("SELECT * FROM outcome_observations WHERE idempotency_key=%s", (key,))
        row = self.cur.fetchone()
        if not row:
            return None
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return _row(cols, row)

    def consultant_outcomes(self, consultant_id: str) -> list[dict]:
        self.cur.execute(
            "SELECT * FROM outcome_observations WHERE consultant_id=%s ORDER BY observed_at, outcome_id",
            (consultant_id,),
        )
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r) for r in rows]

    def outcome_events_for(self, consultant_id: str, opportunity_id: str) -> list[dict]:
        self.cur.execute(
            "SELECT * FROM outcome_observations WHERE consultant_id=%s AND opportunity_id=%s "
            "ORDER BY observed_at, outcome_id",
            (consultant_id, opportunity_id),
        )
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r) for r in rows]

    def save_policy(self, policy: dict) -> None:
        self.cur.execute(
            "INSERT INTO policy_versions "
            "(policy_version, consultant_id, kind, status, weights_json, bounds_json, "
            "parent_version, metadata_json, activated_at, rollback_reason, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                policy["policy_version"], policy["consultant_id"], policy["kind"],
                policy["status"], _dump_json(policy.get("weights_json") or policy.get("weights")),
                _dump_json(policy.get("bounds_json") or policy.get("bounds")),
                policy.get("parent_version", ""),
                _dump_json(policy.get("metadata_json") or policy.get("metadata")),
                policy.get("activated_at"), policy.get("rollback_reason", ""),
                policy["created_at"],
            ),
        )

    def list_policies(self, consultant_id: str, kind: str = "", status: str = "") -> list[dict]:
        sql = "SELECT * FROM policy_versions WHERE consultant_id IN (%s, '')"
        params: list[Any] = [consultant_id]
        if kind:
            sql += " AND kind=%s"
            params.append(kind)
        if status:
            sql += " AND status=%s"
            params.append(status)
        sql += " ORDER BY created_at, policy_version"
        self.cur.execute(sql, tuple(params))
        rows = self.cur.fetchall() or []
        cols = [d[0] for d in getattr(self.cur, "description", None) or []]
        return [_row(cols, r, json_fields=("weights_json", "bounds_json", "metadata_json")) for r in rows]

    def set_policy_status(self, policy_version: str, status: str, rollback_reason: str = "") -> None:
        self.cur.execute(
            "UPDATE policy_versions SET status=%s, rollback_reason=%s WHERE policy_version=%s",
            (status, rollback_reason, policy_version),
        )


class MemoryStore:
    """进程内实现：行为与 MysqlStore 对齐（幂等去重、投影 upsert）。"""

    def __init__(self):
        self.events: list[dict] = []
        self.engagements: dict[tuple[str, str], dict] = {}
        self.outcomes: list[dict] = []
        self.policies: list[dict] = []

    def get_engagement(self, consultant_id: str, opportunity_id: str) -> dict | None:
        row = self.engagements.get((consultant_id, opportunity_id))
        return dict(row) if row else None

    def upsert_engagement(self, row: dict) -> None:
        self.engagements[(row["consultant_id"], row["opportunity_id"])] = dict(row)

    def watched_count(self, consultant_id: str) -> int:
        return sum(1 for (cid, _), row in self.engagements.items()
                   if cid == consultant_id and row["state"] == "WATCHED")

    def append_event(self, event: dict) -> tuple[dict, bool]:
        existing = self.event_by_idempotency(event["idempotency_key"])
        if existing:
            return existing, False
        stored = dict(event)
        self.events.append(stored)
        return stored, True

    def event_by_idempotency(self, key: str) -> dict | None:
        for event in self.events:
            if event["idempotency_key"] == key:
                return event
        return None

    def list_events(self, consultant_id: str, opportunity_id: str) -> list[dict]:
        return [dict(e) for e in self.events
                if e["consultant_id"] == consultant_id and e["opportunity_id"] == opportunity_id]

    def list_engagements(self, consultant_id: str) -> list[dict]:
        return [dict(row) for (cid, _), row in self.engagements.items() if cid == consultant_id]

    def all_events(self) -> list[dict]:
        return [dict(e) for e in self.events]

    def consultant_events(self, consultant_id: str) -> list[dict]:
        return [dict(e) for e in self.events if e["consultant_id"] == consultant_id]

    def append_outcome(self, outcome: dict) -> tuple[dict, bool]:
        existing = self.outcome_by_idempotency(outcome["idempotency_key"])
        if existing:
            return existing, False
        stored = dict(outcome)
        self.outcomes.append(stored)
        return stored, True

    def outcome_by_idempotency(self, key: str) -> dict | None:
        for outcome in self.outcomes:
            if outcome["idempotency_key"] == key:
                return outcome
        return None

    def consultant_outcomes(self, consultant_id: str) -> list[dict]:
        return [dict(o) for o in self.outcomes if o["consultant_id"] == consultant_id]

    def outcome_events_for(self, consultant_id: str, opportunity_id: str) -> list[dict]:
        return [dict(o) for o in self.outcomes
                if o["consultant_id"] == consultant_id and o["opportunity_id"] == opportunity_id]

    def save_policy(self, policy: dict) -> None:
        self.policies.append(dict(policy))

    def list_policies(self, consultant_id: str, kind: str = "", status: str = "") -> list[dict]:
        return [dict(p) for p in self.policies
                if p["consultant_id"] in (consultant_id, "")
                and (not kind or p["kind"] == kind)
                and (not status or p["status"] == status)]

    def set_policy_status(self, policy_version: str, status: str, rollback_reason: str = "") -> None:
        for policy in self.policies:
            if policy["policy_version"] == policy_version:
                policy["status"] = status
                policy["rollback_reason"] = rollback_reason


def rebuild_projection(store: Store, consultant_id: str | None = None) -> dict[tuple[str, str], dict]:
    """由事件账本重建 engagements 投影（§9 投影原则）。

    CORRECTION 事件不改变状态，仅补充 metadata。
    """
    projection: dict[tuple[str, str], dict] = {}
    for event in store.all_events():
        if event.get("event_type") == "CORRECTION":
            continue
        key = (event["consultant_id"], event["opportunity_id"])
        if consultant_id and key[0] != consultant_id:
            continue
        current = projection.get(key)
        version = int(current["state_version"]) + 1 if current else 1
        projection[key] = {
            "consultant_id": key[0],
            "opportunity_id": key[1],
            "state": event.get("next_state") or (current or {}).get("state", "NEW"),
            "state_version": version,
            "last_event_id": event["event_id"],
            "last_action_at": event["occurred_at"],
            "expires_at": None,
            "updated_at": event.get("recorded_at") or event["occurred_at"],
        }
    return projection
