"""状态命令服务（开发文档 v2.0 §4.3/§8）。

五个顾问命令：watch / accept / dismiss / release / complete，
两个系统命令：recommend（日推落账）/ expire（90 天规则扫描）。
所有命令幂等：同 idempotency_key 重复提交返回原事件，不产生重复状态变化。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from decision import engagement as sm
from decision.event_store import Store, make_idempotency_key, new_event_id

# 有效动作：重置 90 天过期时钟（纯同步/重推不算）
_VALID_EVENT_TYPES = {"VIEWED", "WATCHED", "ACCEPTED", "DISMISSED", "RELEASED", "COMPLETED"}


def _now(now: datetime | None) -> datetime:
    return (now or datetime.now()).replace(tzinfo=None)


def execute_command(
    store: Store,
    command: str,
    *,
    consultant_id: str,
    opportunity_id: str,
    idempotency_key: str = "",
    reason_code: str = "",
    outcome_summary: str = "",
    actor: str = "",
    decision_id: int | None = None,
    policy_version: str = "",
    now: datetime | None = None,
    metadata: dict | None = None,
) -> dict[str, Any]:
    """执行一条状态命令，返回 {ok, already, state, event_id, events}。

    - 幂等：同 idempotency_key 直接返回首次结果（already=True）。
    - 补链：watch/accept 从链路前序状态发起时，中间态事件一并落账
      （各自派生幂等键，重试同样安全）。
    """
    now = _now(now)
    actor = actor or consultant_id
    if not idempotency_key:
        idempotency_key = make_idempotency_key(command, consultant_id, opportunity_id, now.date())

    existing = store.event_by_idempotency(idempotency_key)
    if existing:
        eng = store.get_engagement(consultant_id, opportunity_id) or {}
        return {"ok": True, "already": True, "state": eng.get("state", ""),
                "event_id": existing["event_id"], "events": [existing]}

    engagement = store.get_engagement(consultant_id, opportunity_id) or {
        "state": "NEW", "state_version": 0, "expires_at": None,
    }
    state = engagement.get("state", "NEW")
    cooled_until = engagement.get("expires_at") if state == "DISMISSED" else None
    chain = sm.plan_transition(state, command, reason_code=reason_code, now=now, cooled_until=cooled_until)

    if "WATCHED" in chain and state != "WATCHED":
        count = store.watched_count(consultant_id)
        if count >= sm.watch_cap():
            raise sm.CommandError(f"关注位已满（{count}/{sm.watch_cap()}），请先释放")

    emitted: list[dict] = []
    version = int(engagement.get("state_version") or 0)
    for index, target in enumerate(chain):
        event = {
            "event_id": new_event_id(),
            "consultant_id": consultant_id,
            "opportunity_id": opportunity_id,
            "decision_id": decision_id,
            "event_type": target,
            "previous_state": state,
            "next_state": target,
            "actor": actor,
            "reason_code": reason_code if target == chain[-1] else "",
            "metadata_json": {
                "command": command,
                "auto_chain": target != chain[-1] or len(chain) > 1,
                "outcome_summary": outcome_summary if target == "COMPLETED" else "",
                **(metadata or {}),
            },
            "policy_version": policy_version,
            "occurred_at": now,
            "recorded_at": now,
            "idempotency_key": idempotency_key if index == len(chain) - 1 else f"{idempotency_key}:chain:{target}",
        }
        stored, created = store.append_event(event)
        if created:
            emitted.append(stored)
            version += 1
            state = target
            expires_at = None
            if target == "DISMISSED":
                expires_at = sm.cooldown_until(now)
            last_action = now if target in _VALID_EVENT_TYPES else engagement.get("last_action_at") or now
            store.upsert_engagement({
                "consultant_id": consultant_id,
                "opportunity_id": opportunity_id,
                "state": state,
                "state_version": version,
                "last_event_id": stored["event_id"],
                "last_action_at": last_action,
                "expires_at": expires_at,
                "updated_at": now,
            })
        else:
            # 补链事件撞幂等键：以账本为准继续
            state = stored.get("next_state") or state

    final = store.get_engagement(consultant_id, opportunity_id) or {}
    return {"ok": True, "already": False, "state": final.get("state", state),
            "event_id": emitted[-1]["event_id"] if emitted else "",
            "events": emitted}


def expire_stale(store: Store, consultant_id: str, *, now: datetime | None = None,
                 actor: str = "system") -> list[dict]:
    """90 天规则扫描：仅 WATCHED 且超期的承接 EXPIRED；ACCEPTED 永不触碰。"""
    now = _now(now)
    expired = []
    for row in store.list_engagements(consultant_id):
        if not sm.should_expire(row["state"], last_action_at=row.get("last_action_at"), now=now):
            continue
        result = execute_command(
            store, "expire",
            consultant_id=consultant_id,
            opportunity_id=row["opportunity_id"],
            idempotency_key=make_idempotency_key("expire", consultant_id, row["opportunity_id"], now.date()),
            actor=actor,
            now=now,
        )
        expired.append(result)
    return expired


def recommendable_fingerprints(store: Store, consultant_id: str, *, now: datetime | None = None) -> set[str]:
    """S2 硬约束用：冷却期内 / 已承接完结的 fingerprint 集合（不推荐）。"""
    now = _now(now)
    blocked = set()
    for row in store.list_engagements(consultant_id):
        if not sm.is_recommendable(row["state"], now=now, cooled_until=row.get("expires_at")):
            blocked.add(row["opportunity_id"])
    return blocked


def record_outcome(
    store: Store,
    *,
    consultant_id: str,
    opportunity_id: str,
    stage: str,
    value: dict,
    scope: str = "consultant_scoped",
    source: str = "manual",
    recorded_by: str = "",
    idempotency_key: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """结果录入（§8 POST /outcome）。

    - 幂等：同 idempotency_key 返回原结果。
    - 修改语义：同 (consultant, fingerprint, stage) 已有不同值的观察时，
      历史不改，账本追加 CORRECTION 事件指向原 OUTCOME_RECORDED 事件（§7 纠错）。
    """
    now = _now(now)
    if scope not in {"consultant_scoped", "team_aggregate"}:
        raise sm.CommandError("scope 必须是 consultant_scoped 或 team_aggregate")
    if not idempotency_key:
        idempotency_key = make_idempotency_key("outcome", consultant_id, opportunity_id, stage, now.date())
    existing = store.outcome_by_idempotency(idempotency_key)
    if existing:
        return {"ok": True, "already": True, "outcome_id": existing["outcome_id"], "correction": False}

    outcome = {
        "outcome_id": new_event_id(),
        "consultant_id": consultant_id,
        "opportunity_id": opportunity_id,
        "scope": scope,
        "source": source,
        "stage": stage,
        "value_json": value,
        "recorded_by": recorded_by or consultant_id,
        "idempotency_key": idempotency_key,
        "observed_at": now,
        "recorded_at": now,
    }
    store.append_outcome(outcome)

    prior_events = [
        e for e in store.list_events(consultant_id, opportunity_id)
        if e.get("event_type") == "OUTCOME_RECORDED"
        and (e.get("metadata_json") or e.get("metadata") or {}).get("stage") == stage
    ]
    correction = False
    if prior_events:
        prior_outcomes = [o for o in store.outcome_events_for(consultant_id, opportunity_id)
                          if o.get("stage") == stage and o["outcome_id"] != outcome["outcome_id"]]
        if prior_outcomes:
            last = prior_outcomes[-1]
            last_value = last.get("value_json") or last.get("value")
            if last_value != value:
                correction = True
                store.append_event({
                    "event_id": new_event_id(),
                    "consultant_id": consultant_id,
                    "opportunity_id": opportunity_id,
                    "decision_id": None,
                    "event_type": "CORRECTION",
                    "previous_state": "",
                    "next_state": "",
                    "actor": recorded_by or consultant_id,
                    "reason_code": "outcome_correction",
                    "metadata_json": {
                        "corrects_event_id": prior_events[-1]["event_id"],
                        "corrects_outcome_id": last["outcome_id"],
                        "stage": stage,
                        "previous_value": last_value,
                        "new_value": value,
                    },
                    "policy_version": "",
                    "occurred_at": now,
                    "recorded_at": now,
                    "idempotency_key": f"corr:{idempotency_key}",
                })

    store.append_event({
        "event_id": new_event_id(),
        "consultant_id": consultant_id,
        "opportunity_id": opportunity_id,
        "decision_id": None,
        "event_type": "OUTCOME_RECORDED",
        "previous_state": "",
        "next_state": "",
        "actor": recorded_by or consultant_id,
        "reason_code": "",
        "metadata_json": {"stage": stage, "scope": scope, "correction": correction},
        "policy_version": "",
        "occurred_at": now,
        "recorded_at": now,
        "idempotency_key": f"evt:{idempotency_key}",
    })
    return {"ok": True, "already": False, "outcome_id": outcome["outcome_id"], "correction": correction}
