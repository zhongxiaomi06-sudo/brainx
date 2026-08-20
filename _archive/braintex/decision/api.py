"""FastAPI endpoints for recommendation review and weight management."""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import json
import logging
import os
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from decision import commands as decision_commands
from decision import db
from decision import engagement as engagement_sm
from decision import evidence
from decision import personalizer
from decision import policy as decision_policy
from decision.engagement import CommandError
from decision.event_store import MysqlStore
from decision.security import make_token, verify_token
from decision.signal_scorer import DIMENSION_REGISTRY

router = APIRouter(prefix="/api/decision", tags=["decision"])
logger = logging.getLogger(__name__)


class RespondPayload(BaseModel):
    token: str
    action: str
    ignore_reason: str = Field(default="", max_length=255)


class WeightsPayload(BaseModel):
    weights: dict[str, Any]
    note: str = Field(default="", max_length=255)
    changed_by: str = Field(default="", max_length=64)


class CommandPayload(BaseModel):
    fingerprint: str = Field(min_length=1, max_length=64)
    idempotency_key: str = Field(default="", max_length=80)
    reason_code: str = Field(default="", max_length=64)
    outcome_summary: str = Field(default="", max_length=255)


class OutcomePayload(BaseModel):
    fingerprint: str = Field(min_length=1, max_length=64)
    stage: str = Field(min_length=1, max_length=24)
    value: dict[str, Any]
    scope: str = Field(default="consultant_scoped", max_length=16)
    idempotency_key: str = Field(default="", max_length=80)


def _require_actor(x_actor: str | None, authorization: str | None) -> str:
    """命令端点鉴权（§14）：X-Actor 即 consultant_id；设置 RELOOP_API_TOKEN 时校验 Bearer。

    端点不接收 consultant 参数——consultant 恒等于 actor，天然满足
    「请求 consultant 与 actor 不一致拒绝读写」。
    """
    if not x_actor or not x_actor.strip():
        raise HTTPException(400, "缺少 X-Actor 头")
    token = os.getenv("RELOOP_API_TOKEN", "")
    if token:
        expected = f"Bearer {token}"
        if authorization != expected:
            raise HTTPException(401, "鉴权失败")
    return x_actor.strip()


def _run_command(command: str, payload: CommandPayload, actor: str) -> dict[str, Any]:
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                result = decision_commands.execute_command(
                    MysqlStore(cur), command,
                    consultant_id=actor,
                    opportunity_id=payload.fingerprint,
                    idempotency_key=payload.idempotency_key,
                    reason_code=payload.reason_code,
                    outcome_summary=payload.outcome_summary,
                    actor=actor,
                )
            conn.commit()
        result.pop("events", None)
        return result
    except CommandError as exc:
        raise HTTPException(409, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("状态命令执行失败")
        raise HTTPException(500, "状态命令执行失败") from exc


def _row_dict(row: Any, columns: list[str] | None = None) -> dict[str, Any]:
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, "keys"):
        return {key: row[key] for key in row.keys()}
    return dict(zip(columns or [], row))


def _json(value: Any, fallback: Any) -> Any:
    if isinstance(value, (str, bytes, bytearray)):
        try:
            parsed = json.loads(value)
            return parsed
        except (ValueError, TypeError):
            return fallback
    return value if value is not None else fallback


def _get_rec(cur: Any, rec_id: int) -> dict[str, Any] | None:
    cur.execute("SELECT * FROM recommendations WHERE id=%s", (rec_id,))
    row = cur.fetchone()
    return _row_dict(row, [item[0] for item in (getattr(cur, "description", None) or [])]) if row else None


def _fetch_dicts(cur: Any, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    cur.execute(sql, params)
    rows = cur.fetchall() or []
    columns = [item[0] for item in (getattr(cur, "description", None) or [])]
    return [_row_dict(row, columns) for row in rows]


def _auth_rec(token: str) -> tuple[int, dict[str, Any]]:
    try:
        rec_id = verify_token(token)
    except RuntimeError as exc:
        logger.exception("决策 HMAC 配置错误")
        raise HTTPException(500, "决策服务配置错误") from exc
    except ValueError as exc:
        raise HTTPException(401, "无效token") from exc
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                rec = _get_rec(cur, rec_id)
        if not rec:
            raise HTTPException(404, "推荐不存在")
        return rec_id, rec
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("读取推荐失败")
        raise HTTPException(500, "读取推荐失败") from exc


def _preview(rec: dict[str, Any]) -> dict[str, Any]:
    reasons = _json(rec.get("reasons_json"), {})
    dimensions = reasons.get("dimensions", []) if isinstance(reasons, dict) else []
    trial = _json(rec.get("trial_candidates_json"), [])
    return {
        "rec_id": rec.get("id"),
        "fingerprint": rec.get("job_signal_fingerprint", ""),
        "job_title": rec.get("job_title", ""),
        "company": rec.get("company", ""),
        "total_score": float(rec.get("total_score", 0)),
        "status": rec.get("status", ""),
        "action": rec.get("action", ""),
        "confidence_band": rec.get("confidence_band", ""),
        "evidence_coverage": float(rec.get("evidence_coverage") or 0),
        "policy_version": rec.get("policy_version", ""),
        "dimensions": dimensions if isinstance(dimensions, list) else [],
        "trial_candidates": trial if isinstance(trial, list) else [],
    }


@router.get("/preview")
def preview(token: str) -> dict[str, Any]:
    _rec_id, rec = _auth_rec(token)
    return _preview(rec)


@router.post("/respond")
def respond(payload: RespondPayload) -> dict[str, Any]:
    if payload.action not in {"adopt", "ignore"}:
        raise HTTPException(422, "action 必须是 adopt 或 ignore")
    rec_id, _rec = _auth_rec(payload.token)
    event_type = "adopted" if payload.action == "adopt" else "ignored"
    request_id = payload.token.split(".", 1)[1]
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                rec = _get_rec(cur, rec_id)
                if not rec:
                    raise HTTPException(404, "推荐不存在")
                if rec.get("sent_at") is None:
                    raise HTTPException(409, "推荐尚未推送")
                if rec.get("status") != "pending":
                    return {"ok": True, "already": True, "status": rec.get("status")}
                ignore_reason = payload.ignore_reason if payload.action == "ignore" else ""
                cur.execute(
                    "UPDATE recommendations SET status=%s, ignore_reason=%s WHERE id=%s AND status='pending'",
                    (event_type, ignore_reason, rec_id),
                )
                if getattr(cur, "rowcount", 1) == 0:
                    latest = _get_rec(cur, rec_id) or {}
                    return {"ok": True, "already": True, "status": latest.get("status")}
                cur.execute(
                    "INSERT INTO adoption_events "
                    "(recommendation_id, request_id, event_type, actor, detail_json) "
                    "VALUES (%s, %s, %s, %s, %s) "
                    "ON DUPLICATE KEY UPDATE request_id=VALUES(request_id)",
                    (rec_id, request_id, event_type, rec.get("consultant", ""), json.dumps({"ignore_reason": ignore_reason}, ensure_ascii=False)),
                )
                # 双写事件账本（§8 respond 保留兼容，内部转映射命令）。
                # 兼容端点不破坏旧语义：账本映射失败仅记录日志，事务不回滚。
                try:
                    consultant = rec.get("consultant", "") or "unknown"
                    store = MysqlStore(cur)
                    if store.get_engagement(consultant, rec.get("job_signal_fingerprint", "")) is None:
                        decision_commands.execute_command(
                            store, "recommend",
                            consultant_id=consultant,
                            opportunity_id=rec.get("job_signal_fingerprint", ""),
                            idempotency_key=f"respond:{request_id}:recommend",
                            decision_id=rec_id,
                        )
                    decision_commands.execute_command(
                        store,
                        "accept" if payload.action == "adopt" else "dismiss",
                        consultant_id=consultant,
                        opportunity_id=rec.get("job_signal_fingerprint", ""),
                        idempotency_key=f"respond:{request_id}",
                        reason_code=ignore_reason if payload.action == "ignore" else "",
                        decision_id=rec_id,
                        metadata={"source": "respond_compat"},
                    )
                except CommandError as exc:
                    logger.warning("respond 账本映射跳过：%s", exc)
            conn.commit()
        return {"ok": True, "already": False, "status": event_type}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("记录响应失败")
        raise HTTPException(500, "记录响应失败") from exc


@router.get("/stats")
def stats(days: int = Query(default=7)) -> dict[str, Any]:
    days = max(1, min(90, days))
    cutoff = date.today() - timedelta(days=days - 1)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT rec_date, sent_at, status FROM recommendations WHERE rec_date >= %s AND rec_date <= CURDATE()", (cutoff.isoformat(),))
                rows = cur.fetchall() or []
                columns = [item[0] for item in (getattr(cur, "description", None) or [])]
        pushed = responded = adopted = ignored = pending = 0
        by_day: dict[str, dict[str, Any]] = {}
        for raw in rows:
            row = _row_dict(raw, columns)
            day = row.get("rec_date")
            day = day.isoformat()[:10] if hasattr(day, "isoformat") else str(day)[:10]
            item = by_day.setdefault(day, {"date": day, "pushed": 0, "adopted": 0, "ignored": 0})
            if row.get("sent_at") is not None:
                pushed += 1
                item["pushed"] += 1
            status = row.get("status")
            if status == "adopted":
                adopted += 1
                item["adopted"] += 1
            elif status == "ignored":
                ignored += 1
                item["ignored"] += 1
            elif status == "pending":
                pending += 1
            if row.get("sent_at") is not None and status in {"adopted", "ignored"}:
                responded += 1
        return {"days": days, "pushed": pushed, "responded": responded, "adopted": adopted, "ignored": ignored, "pending": pending, "response_rate": responded / pushed if pushed else None, "adoption_rate": adopted / (adopted + ignored) if adopted + ignored else None, "by_day": sorted(by_day.values(), key=lambda item: item["date"]) }
    except Exception as exc:
        logger.exception("统计失败")
        raise HTTPException(500, "统计失败") from exc


@router.get("/today")
def today() -> dict[str, Any]:
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM recommendations WHERE rec_date=CURDATE() ORDER BY total_score DESC")
                rows = cur.fetchall() or []
                columns = [item[0] for item in (getattr(cur, "description", None) or [])]
        items = []
        for raw in rows:
            rec = _row_dict(raw, columns)
            item = _preview(rec)
            item.update({"sent_at": rec.get("sent_at"), "signal_type": rec.get("signal_type", ""), "token": make_token(rec["id"], rec["rec_date"]) if rec.get("sent_at") is not None and rec.get("status") == "pending" else None})
            items.append(item)
        return {"items": items, "count": len(items)}
    except RuntimeError as exc:
        logger.exception("读取今日推荐配置失败")
        raise HTTPException(500, "读取今日推荐失败") from exc
    except Exception as exc:
        logger.exception("读取今日推荐失败")
        raise HTTPException(500, "读取今日推荐失败") from exc


@router.get("/weights")
def get_weights() -> dict[str, Any]:
    try:
        current = db.current_weights(seed=False)
        return {"version": current["version"], "weights": current["weights"], "registry": DIMENSION_REGISTRY}
    except Exception as exc:
        logger.exception("读取权重失败")
        raise HTTPException(500, "读取权重失败") from exc


@router.post("/weights")
def save_weights(payload: WeightsPayload, x_actor: str | None = Header(default=None),
                 authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """手工调权（§6.3）：默认锁定，仅「连续 2 轮不满意」解锁的顾问可写。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                progress = _unlock_state(MysqlStore(cur), actor)
        if not progress["unlocked"]:
            raise HTTPException(403, {
                "detail": "手工调权未解锁",
                "rounds_to_go": progress["rounds_to_go"],
                "hint": f"还需 {progress['rounds_to_go']} 轮不满意反馈解锁手工调权",
            })
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("解锁状态检查失败")
        raise HTTPException(500, "解锁状态检查失败") from exc
    expected = set(DIMENSION_REGISTRY)
    actual = set(payload.weights)
    if actual != expected:
        raise HTTPException(422, {"detail": "维度不匹配", "unknown": sorted(actual - expected), "missing": sorted(expected - actual)})
    try:
        weights = {}
        for name, value in payload.weights.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
                raise HTTPException(422, f"权重 {name} 必须是 0 到 1 的数值")
            weights[name] = float(value)
        total = sum(weights.values())
        normalized = abs(total - 1.0) > 0.01
        if normalized:
            if total <= 0:
                raise HTTPException(422, "权重总和必须大于 0")
            weights = {name: value / total for name, value in weights.items()}
        personalizer.validate_weights(weights)
        now = datetime.now()
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                store = MysqlStore(cur)
                for old in store.list_policies(actor, kind="manual_override", status="active"):
                    store.set_policy_status(old["policy_version"], "superseded")
                version = f"manual-{actor}-{now.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
                store.save_policy({
                    "policy_version": version,
                    "consultant_id": actor,
                    "kind": "manual_override",
                    "status": "active",
                    "weights": weights,
                    "bounds": {k: list(v) for k, v in personalizer.DEFAULT_BOUNDS.items()},
                    "parent_version": "",
                    "metadata": {
                        "manual_tuning_unlocked": True,
                        "trigger": payload.note or "两轮不满意触发手工面板",
                        "changed_by": payload.changed_by or actor,
                    },
                    "activated_at": now,
                    "created_at": now,
                })
            conn.commit()
        return {"ok": True, "version": version, "kind": "manual_override",
                "weights": weights, "normalized": normalized}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        logger.exception("保存权重失败")
        raise HTTPException(500, "保存权重失败") from exc


# ---------------------------------------------------------------------------
# S1：承接生命周期命令端点（§8）
# ---------------------------------------------------------------------------


@router.post("/command/watch")
def command_watch(payload: CommandPayload, x_actor: str | None = Header(default=None),
                  authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return _run_command("watch", payload, _require_actor(x_actor, authorization))


@router.post("/command/accept")
def command_accept(payload: CommandPayload, x_actor: str | None = Header(default=None),
                   authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return _run_command("accept", payload, _require_actor(x_actor, authorization))


@router.post("/command/dismiss")
def command_dismiss(payload: CommandPayload, x_actor: str | None = Header(default=None),
                    authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return _run_command("dismiss", payload, _require_actor(x_actor, authorization))


@router.post("/command/release")
def command_release(payload: CommandPayload, x_actor: str | None = Header(default=None),
                    authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return _run_command("release", payload, _require_actor(x_actor, authorization))


@router.post("/command/complete")
def command_complete(payload: CommandPayload, x_actor: str | None = Header(default=None),
                     authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return _run_command("complete", payload, _require_actor(x_actor, authorization))


@router.get("/engagements")
def engagements(x_actor: str | None = Header(default=None),
                authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """我的承接列表（按 state 分组）；读取前先做 90 天规则惰性扫描。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                store = MysqlStore(cur)
                decision_commands.expire_stale(store, actor)
                rows = store.list_engagements(actor)
                capacity = store.watched_count(actor)
            conn.commit()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("读取承接列表失败")
        raise HTTPException(500, "读取承接列表失败") from exc
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        item = {
            "fingerprint": row["opportunity_id"],
            "state": row["state"],
            "state_version": row["state_version"],
            "last_action_at": str(row.get("last_action_at") or ""),
            "expires_at": str(row.get("expires_at") or ""),
        }
        grouped.setdefault(row["state"], []).append(item)
    return {
        "consultant": actor,
        "watch_capacity": {"used": capacity, "cap": engagement_sm.watch_cap()},
        "groups": grouped,
        "count": len(rows),
    }


@router.get("/engagements/{fingerprint}/timeline")
def engagement_timeline(fingerprint: str, x_actor: str | None = Header(default=None),
                        authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """事件时间线（回放基础）：只读本人事件。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                events = MysqlStore(cur).list_events(actor, fingerprint)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("读取事件时间线失败")
        raise HTTPException(500, "读取事件时间线失败") from exc
    items = [{
        "event_id": e["event_id"],
        "event_type": e["event_type"],
        "previous_state": e.get("previous_state", ""),
        "next_state": e.get("next_state", ""),
        "actor": e.get("actor", ""),
        "reason_code": e.get("reason_code", ""),
        "occurred_at": str(e.get("occurred_at") or ""),
        "idempotency_key": e.get("idempotency_key", ""),
    } for e in events]
    return {"consultant": actor, "fingerprint": fingerprint, "events": items, "count": len(items)}


# ---------------------------------------------------------------------------
# S3：回放 / 反馈录入 / 策略与解锁（§8）
# ---------------------------------------------------------------------------


def _unlock_state(store: Any, actor: str) -> dict[str, Any]:
    responses = decision_policy.responses_from_events(
        store.consultant_events(actor), store.consultant_outcomes(actor),
    )
    return decision_policy.unlock_progress(responses)


@router.get("/policy")
def get_policy(x_actor: str | None = Header(default=None),
               authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """当前生效策略 + 手工调权解锁状态 + 不满意计数进度（weights 页三态数据源）。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                store = MysqlStore(cur)
                progress = _unlock_state(store, actor)
                baseline = decision_policy.current_policy(db.current_weights(seed=False))
                policy = personalizer.resolve(store, actor, baseline)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("读取策略失败")
        raise HTTPException(500, "读取策略失败") from exc
    return {
        "consultant": actor,
        "policy": policy,
        "baseline": baseline,
        "manual_tuning": {
            "unlocked": progress["unlocked"],
            "streak": progress["streak"],
            "rounds_to_go": progress["rounds_to_go"],
            "hint": "连续 2 轮反馈不满意，已为你开放手工调权" if progress["unlocked"]
                    else f"还需 {progress['rounds_to_go']} 轮不满意反馈解锁手工调权",
        },
        "registry": DIMENSION_REGISTRY,
    }


@router.post("/policy/learn")
def policy_learn(x_actor: str | None = Header(default=None),
                 authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """触发个人自动策略学习：样本门槛内则产出 Shadow 版本（不接管排序）。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                store = MysqlStore(cur)
                baseline = decision_policy.current_policy(db.current_weights(seed=False))
                current = personalizer.resolve(store, actor, baseline)
                result = personalizer.maybe_learn(store, actor, current["weights"])
            conn.commit()
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("策略学习失败")
        raise HTTPException(500, "策略学习失败") from exc


@router.post("/policy/rollback")
def policy_rollback(x_actor: str | None = Header(default=None),
                    authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """手工覆盖一键回滚（§6.3：任何时刻可回滚 baseline）。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                result = personalizer.rollback_manual(MysqlStore(cur), actor)
            conn.commit()
        if not result["ok"]:
            raise HTTPException(409, result["detail"])
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("回滚失败")
        raise HTTPException(500, "回滚失败") from exc


# ---------------------------------------------------------------------------
# S5：对外证据供给（§8，只读，供 Felix 线消费）
# ---------------------------------------------------------------------------


def _require_reader(authorization: str | None) -> None:
    """证据接口鉴权：设置 RELOOP_API_TOKEN 时需 Bearer；只读，无 consultant 维度。"""
    token = os.getenv("RELOOP_API_TOKEN", "")
    if token and authorization != f"Bearer {token}":
        raise HTTPException(401, "鉴权失败")


@router.get("/evidence/supply")
def evidence_supply(fingerprint: str = Query(min_length=1),
                    authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """供给证据（决策③）：hits、Top3 试单人、score 分布；phone/email 不出接口。"""
    _require_reader(authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                signals = _fetch_dicts(
                    cur,
                    "SELECT fingerprint, job_title, company, keywords_json, signal_type, "
                    "last_seen_at, excerpt FROM job_signals WHERE fingerprint=%s LIMIT 1",
                    (fingerprint,),
                )
                if not signals:
                    raise HTTPException(404, "信号不存在")
                candidates = _fetch_dicts(
                    cur,
                    "SELECT fingerprint, name, raw_text, phone, email FROM cloud_candidates "
                    "WHERE char_length(raw_text) > 100",
                )
        payload = evidence.build_supply_evidence(signals[0], candidates, now=datetime.now())
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("供给证据生成失败")
        raise HTTPException(500, "供给证据生成失败") from exc


@router.get("/evidence/job-signals")
def evidence_job_signals(since: str = Query(default=""), type: str = Query(default=""),
                         limit: int = Query(default=200, le=1000),
                         authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """job_signals FactSource 契约输出（决策④）：Felix 线直接消费，不重复采集。"""
    _require_reader(authorization)
    sql = ("SELECT fingerprint, job_title, company, keywords_json, signal_type, last_seen_at, excerpt "
           "FROM job_signals WHERE 1=1")
    params: list[Any] = []
    if since:
        sql += " AND last_seen_at >= %s"
        params.append(since)
    if type:
        sql += " AND signal_type = %s"
        params.append(type)
    sql += " ORDER BY last_seen_at DESC LIMIT %s"
    params.append(limit)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                rows = _fetch_dicts(cur, sql, tuple(params))
        return evidence.build_job_signals_factsource(rows, now=datetime.now(),
                                                     since=since, signal_type=type)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("job-signals 证据输出失败")
        raise HTTPException(500, "job-signals 证据输出失败") from exc


@router.get("/replay/{rec_id}")
def replay(rec_id: int, x_actor: str | None = Header(default=None),
           authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """决策回放：JD 快照 + 5 维特征 + policy_version + 排序位置 + 事件时间线。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                rec = _get_rec(cur, rec_id)
                if not rec:
                    raise HTTPException(404, "推荐不存在")
                consultant = rec.get("consultant", "")
                cur.execute(
                    "SELECT id, total_score, evidence_coverage FROM recommendations "
                    "WHERE rec_date=%s AND consultant=%s ORDER BY total_score DESC, "
                    "evidence_coverage DESC, job_signal_fingerprint ASC",
                    (rec.get("rec_date"), consultant),
                )
                peers = cur.fetchall() or []
                store = MysqlStore(cur)
                events = [e for e in store.list_events(consultant, rec.get("job_signal_fingerprint", ""))
                          if e.get("decision_id") in (None, rec_id)]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("决策回放失败")
        raise HTTPException(500, "决策回放失败") from exc
    rank = next((i + 1 for i, row in enumerate(peers)
                 if int(row[0] if not isinstance(row, dict) else row["id"]) == rec_id), None)
    item = _preview(rec)
    item["jd_text_snapshot"] = rec.get("jd_text_snapshot") or ""
    item["rec_date"] = str(rec.get("rec_date") or "")
    item["consultant"] = consultant
    item["weight_version"] = int(rec.get("weight_version") or 0)
    return {
        "recommendation": item,
        "rank": {"position": rank, "total": len(peers), "rec_date": str(rec.get("rec_date") or "")},
        "timeline": [{
            "event_id": e["event_id"], "event_type": e["event_type"],
            "previous_state": e.get("previous_state", ""), "next_state": e.get("next_state", ""),
            "actor": e.get("actor", ""), "occurred_at": str(e.get("occurred_at") or ""),
        } for e in events],
        "viewer": actor,
    }


@router.post("/outcome")
def record_outcome(payload: OutcomePayload, x_actor: str | None = Header(default=None),
                   authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """结果录入（stage/数值/scope，幂等）；同 stage 不同值修改只产生 CORRECTION。"""
    actor = _require_actor(x_actor, authorization)
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                result = decision_commands.record_outcome(
                    MysqlStore(cur),
                    consultant_id=actor,
                    opportunity_id=payload.fingerprint,
                    stage=payload.stage,
                    value=payload.value,
                    scope=payload.scope,
                    recorded_by=actor,
                    idempotency_key=payload.idempotency_key,
                )
            conn.commit()
        return result
    except CommandError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("结果录入失败")
        raise HTTPException(500, "结果录入失败") from exc


# ── 飞书连接（每人自己的驾驶舱 → 共享 RDS） ─────────────────────
from decision import feishu_link  # noqa: E402

feishu_router = APIRouter(prefix="/api/feishu", tags=["feishu"])


@feishu_router.get("/status")
def feishu_status() -> dict[str, Any]:
    """连接面板状态：lark-cli 装没装、登录没登录、登录流进度、上次同步结果。"""
    return feishu_link.link_status()


class ProvisionPayload(BaseModel):
    app_id: str = Field(min_length=4, max_length=64)
    app_secret: str = Field(min_length=8, max_length=128)
    brand: str = Field(default="feishu", max_length=16)


@feishu_router.post("/provision")
def feishu_provision(payload: ProvisionPayload, x_actor: str | None = Header(default=None),
                     authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """初始化本机 lark-cli 的 App 凭据（一次性）。凭据由发包人线下发给同事。"""
    _require_actor(x_actor, authorization)
    if not feishu_link.lark_cli_path():
        raise HTTPException(400, "lark_cli_not_installed：先装 lark-cli（brew install lark-cli 或找发包人）")
    try:
        st = feishu_link.provision(payload.app_id, payload.app_secret, payload.brand)
    except feishu_link.FeishuLinkError as exc:
        raise HTTPException(502, f"lark-cli 初始化失败：{exc}") from exc
    return {"ok": True, "configured": True, "logged_in": bool(st.get("logged_in"))}


@feishu_router.post("/connect")
def feishu_connect(x_actor: str | None = Header(default=None),
                   authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """点「连接飞书」：发起设备流授权，返回 verification_url 给用户去浏览器点。"""
    _require_actor(x_actor, authorization)
    if not feishu_link.lark_cli_path():
        raise HTTPException(400, "lark_cli_not_installed：先装 lark-cli（brew install lark-cli 或找发包人）")
    status = feishu_link.auth_status()
    if status.get("logged_in"):
        return {"ok": True, "already": True, "user_name": status.get("user_name")}
    try:
        flow = feishu_link.begin_login()
    except feishu_link.FeishuLinkError as exc:
        raise HTTPException(502, f"发起飞书授权失败：{exc}") from exc
    return {"ok": True, "already": False, **flow}


@feishu_router.post("/sync")
def feishu_sync(x_actor: str | None = Header(default=None),
                authorization: str | None = Header(default=None),
                background: bool = Query(default=True),
                since_days: int = Query(default=3, ge=1, le=30)) -> dict[str, Any]:
    """手动触发同步（默认后台跑，轮询 /status 看结果）；驾驶舱群 → job_signals。"""
    _require_actor(x_actor, authorization)
    if background:
        started = feishu_link.run_sync_background(trigger="manual", since_days=since_days)
        return {"ok": started, "status": "started" if started else "already_running"}
    return feishu_link.run_sync(trigger="manual", since_days=since_days)


# ── 同事上传简历 → 共享 cloud_candidates ────────────────────────
from fastapi import File, UploadFile  # noqa: E402

from decision import candidate_upload  # noqa: E402

upload_router = APIRouter(prefix="/api/upload", tags=["upload"])

ALLOWED_UPLOAD_EXT = (".pdf", ".docx", ".txt", ".md")
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 单文件 20MB 上限


@upload_router.post("/resume")
async def upload_resume(files: list[UploadFile] = File(...),
                        x_actor: str | None = Header(default=None),
                        authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """上传简历文件（pdf/docx/txt/md，可多选）→ 解析 → 幂等 upsert 共享库。"""
    actor = _require_actor(x_actor, authorization)
    if not files:
        raise HTTPException(400, "没有文件")
    if len(files) > 50:
        raise HTTPException(400, "一次最多 50 个文件")
    payloads: list[tuple[str, bytes]] = []
    rejected: list[dict[str, Any]] = []
    for f in files:
        name = f.filename or "unknown"
        ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in ALLOWED_UPLOAD_EXT:
            rejected.append({"filename": name, "ok": False,
                             "error": f"不支持的类型 {ext}（支持 pdf/docx/txt/md）"})
            continue
        data = await f.read()
        if len(data) > MAX_UPLOAD_BYTES:
            rejected.append({"filename": name, "ok": False, "error": "超过 20MB 上限"})
            continue
        payloads.append((name, data))
    out: dict[str, Any] = {"inserted": 0, "updated": 0, "failed": 0, "results": []}
    if payloads:
        try:
            with db.get_conn() as conn:
                out = candidate_upload.upload_resume_files(payloads, actor, conn)
        except Exception as exc:
            logger.exception("简历上传写库失败")
            raise HTTPException(500, f"写库失败：{str(exc)[:200]}") from exc
    out["results"].extend(rejected)
    out["failed"] += len(rejected)
    out["ok"] = out["failed"] == 0
    out["uploader"] = actor
    return out


# ── 客户中心（L0 档案/归一人审 · L2 客户360 · L3 每日动态摘要） ──
from decision import clients as client_mod  # noqa: E402

clients_router = APIRouter(prefix="/api/clients", tags=["clients"])


class ClientReviewPayload(BaseModel):
    client_id: str = Field(min_length=1, max_length=32)
    action: str = Field(min_length=1, max_length=16)  # confirm / rename / merge
    canonical_name: str = Field(default="", max_length=128)
    merge_into: str = Field(default="", max_length=32)


class DigestReviewPayload(BaseModel):
    client_id: str = Field(min_length=1, max_length=32)
    digest_date: str = Field(min_length=8, max_length=10)
    action: str = Field(min_length=1, max_length=16)  # confirm / correct
    corrected_text: str = Field(default="", max_length=2000)


@clients_router.get("")
def clients_list(include_pending: bool = Query(default=True)) -> dict[str, Any]:
    """客户列表（按热度/最新动态排序），含各客户信号统计。"""
    with db.get_conn() as conn:
        return {"items": client_mod.list_clients(conn, include_pending=include_pending)}


@clients_router.post("/sync")
def clients_sync(x_actor: str | None = Header(default=None),
                 authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """从 job_signals 重新聚类客户（增量幂等，新人审前不产生 confirmed）。"""
    _require_actor(x_actor, authorization)
    cockpit: list[dict[str, str]] = []
    try:
        from decision import feishu_link
        if feishu_link.auth_status().get("logged_in"):
            cockpit = feishu_link.discover_signal_groups()
    except Exception:
        cockpit = []  # 无 lark-cli 环境也能跑（群映射退化为空）
    with db.get_conn() as conn:
        result = client_mod.sync_clients_from_signals(conn, cockpit_chats=cockpit)
        conn.commit()
    return result


@clients_router.get("/{client_id}")
def clients_detail(client_id: str) -> dict[str, Any]:
    """客户 360：档案 + 信号时间线 + 承接 + 结果反馈 + 历史摘要。"""
    with db.get_conn() as conn:
        detail = client_mod.client_detail(conn, client_id)
    if not detail:
        raise HTTPException(404, "客户不存在")
    return detail


@clients_router.post("/review")
def clients_review(payload: ClientReviewPayload, x_actor: str | None = Header(default=None),
                   authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """归一人审：confirm / rename / merge。"""
    actor = _require_actor(x_actor, authorization)
    with db.get_conn() as conn:
        result = client_mod.review_client(
            conn, payload.client_id, payload.action, actor,
            canonical_name=payload.canonical_name, merge_into=payload.merge_into,
        )
        conn.commit()
    if not result.get("ok"):
        raise HTTPException(422, result.get("error", "review failed"))
    return result


@clients_router.post("/{client_id}/digest")
def clients_digest_generate(client_id: str, x_actor: str | None = Header(default=None),
                            authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """生成/刷新该客户今日动态摘要（幂等）。"""
    _require_actor(x_actor, authorization)
    with db.get_conn() as conn:
        result = client_mod.generate_digest(conn, client_id)
        conn.commit()
    if not result.get("ok"):
        raise HTTPException(404, result.get("error", "client_not_found"))
    return result


@clients_router.post("/digest/review")
def clients_digest_review(payload: DigestReviewPayload, x_actor: str | None = Header(default=None),
                          authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """摘要确认/纠正：写回账本（stage=digest_review），喂养个人调权。"""
    actor = _require_actor(x_actor, authorization)
    if payload.action not in ("confirm", "correct"):
        raise HTTPException(422, "action 必须是 confirm 或 correct")
    if payload.action == "correct" and not payload.corrected_text.strip():
        raise HTTPException(422, "纠正必须填写 corrected_text")
    now_s = datetime.now(client_mod.LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S")
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE client_digest SET status=%s, corrected_text=%s, reviewed_by=%s, updated_at=%s "
                "WHERE client_id=%s AND digest_date=%s",
                ("confirmed" if payload.action == "confirm" else "corrected",
                 payload.corrected_text or None, actor, now_s,
                 payload.client_id, payload.digest_date),
            )
            if cur.rowcount == 0:
                raise HTTPException(404, "该日期摘要不存在，先生成")
            result = decision_commands.record_outcome(
                MysqlStore(cur),
                consultant_id=actor,
                opportunity_id=f"client:{payload.client_id}",
                stage="digest_review",
                value={
                    "digest_date": payload.digest_date,
                    "rating": 5 if payload.action == "confirm" else 2,
                    "corrected_text": payload.corrected_text or "",
                },
                scope="consultant_scoped",
                recorded_by=actor,
            )
        conn.commit()
    return {"ok": True, "ledger": result}
