"""Braintex 决策系统 MCP server——Codex / Claude / 其他 agent 群体调用的插件入口。

设计原则：
1. **操作逻辑与 HTTP app 完全一致**——写工具直接调 commands/personalizer/policy
   同一套领域函数（状态机补链、幂等键、关注位上限、CORRECTION 纠错、两轮不满意
   解锁门禁、manual_override > auto_active > baseline 解析），不复制逻辑。
2. **强制鉴权（fail-closed）**——启动时缺少 TTC_DECISION_MCP_TOKEN 直接拒绝服务
   （exit 2）；**每个工具调用**（含只读）都必须携带匹配 token 与 actor，
   缺/错一律拒绝。访问控制全靠鉴权，数据不脱敏（2026-08-05 拍板）。
3. **顾问隔离**——actor 即 consultant_id，工具不接收 consultant 参数，
   天然满足「请求 consultant 与 actor 不一致拒绝读写」。
4. **agent 阅读逻辑**——返回紧凑 JSON；承接列表逐行附 legal_commands（当前态
   可执行的命令），错误响应附 state 与 legal_commands，agent 可自然语言链式操作。

注册（Codex / Claude Code / OpenCode 通用 stdio）：
    command: ~/Downloads/ttc的交易系统/candidate-collector/.venv/bin/python
    args:    ["-m", "decision.mcp_server"]
    cwd:     ~/Downloads/braintex
    env:     PYTHONPATH=~/Downloads/braintex
             TTC_DECISION_MCP_TOKEN=<共享令牌>
             RDS_HOST/RDS_USER/RDS_PASSWORD（或 cloud_sync 可读 .env）

注意：不要加 ``from __future__ import annotations``——FastMCP 注册直接 inspect
原始注解，字符串化注解会让 issubclass 抛 TypeError。
"""

import hmac
import json
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from decision import _bootstrap  # noqa: F401
from decision import commands as decision_commands
from decision import db
from decision import engagement as sm
from decision import evidence
from decision import personalizer
from decision import policy as policy_rules
from decision.event_store import MemoryStore, MysqlStore, rebuild_projection

mcp = FastMCP("braintex")

CONSULTANT_COMMANDS = ("watch", "accept", "dismiss", "release", "complete")
SYSTEM_COMMANDS = ("recommend", "expire", "view")

# 测试/离线注入点：生产走 RDS；测试置 memory store 与内存数据源。
_MEMORY_STORE: Optional[MemoryStore] = None


def _err(message: str, code: str = "error", **extra: Any) -> dict[str, Any]:
    return {"ok": False, "code": code, "error": message, **extra}


# ---------------------------------------------------------------------------
# 强制鉴权
# ---------------------------------------------------------------------------

def _env_token() -> str:
    return os.getenv("TTC_DECISION_MCP_TOKEN", "")


def _auth(token: str, actor: str) -> Optional[dict[str, Any]]:
    """每次调用（含只读）强制鉴权。返回 None=通过，否则为错误响应。"""
    if not _env_token():
        return _err("服务端未配置 TTC_DECISION_MCP_TOKEN，按 fail-closed 拒绝服务",
                    "server_not_configured")
    if not token or not token.strip():
        return _err("缺少 token：所有读写调用必须携带有效 token", "missing_token")
    if not hmac.compare_digest(token.strip(), _env_token()):
        return _err("鉴权失败：token 无效", "auth_failed")
    if not actor or not actor.strip():
        return _err("缺少 actor：actor 即 consultant_id，读写操作必须声明身份", "missing_actor")
    return None


@contextmanager
def _store_ctx():
    """生产：RDS MysqlStore + 提交；测试（TTC_DECISION_MCP_STORE=memory）：内存实现。"""
    global _MEMORY_STORE
    if os.getenv("TTC_DECISION_MCP_STORE", "") == "memory":
        if _MEMORY_STORE is None:
            _MEMORY_STORE = MemoryStore()
        yield _MEMORY_STORE
        return
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            yield MysqlStore(cur)
        conn.commit()


def _now() -> datetime:
    return datetime.now().replace(tzinfo=None)


def _legal_commands(state: str, *, cooled_until: Any = None) -> list[str]:
    """agent 阅读逻辑：当前态可执行的顾问命令（不写也先告诉 agent 能做什么）。"""
    now = _now()
    legal = []
    for cmd in CONSULTANT_COMMANDS:
        try:
            sm.plan_transition(state, cmd, reason_code="占位", now=now, cooled_until=cooled_until)
            legal.append(cmd)
        except sm.CommandError:
            continue
    return legal


def _stringify(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, dict):
        return {k: _stringify(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_stringify(v) for v in value]
    return value


def _unlock_state(store: Any, actor: str) -> dict[str, Any]:
    responses = policy_rules.responses_from_events(
        store.consultant_events(actor), store.consultant_outcomes(actor))
    return policy_rules.unlock_progress(responses)


# ---------------------------------------------------------------------------
# 读工具数据面（生产走 SQL；测试可整体替换）
# ---------------------------------------------------------------------------

def _fetch_dicts(cur: Any, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    cur.execute(sql, params)
    cols = [d[0] for d in (getattr(cur, "description", None) or [])]
    rows = cur.fetchall() or []
    out = []
    for row in rows:
        data = row if isinstance(row, dict) else dict(zip(cols, row))
        out.append(data)
    return out


def _fetch_today(actor: str) -> list[dict[str, Any]]:
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            return _fetch_dicts(
                cur,
                "SELECT * FROM recommendations WHERE rec_date=CURDATE() AND consultant=%s "
                "ORDER BY total_score DESC",
                (actor,),
            )


def _fetch_signal(fingerprint: str) -> Optional[dict[str, Any]]:
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            rows = _fetch_dicts(
                cur,
                "SELECT fingerprint, job_title, company, keywords_json, signal_type, "
                "last_seen_at, excerpt FROM job_signals WHERE fingerprint=%s LIMIT 1",
                (fingerprint,),
            )
    return rows[0] if rows else None


def _fetch_supply_candidates() -> list[dict[str, Any]]:
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            return _fetch_dicts(
                cur,
                "SELECT fingerprint, name, raw_text, phone, email FROM cloud_candidates "
                "WHERE char_length(raw_text) > 100",
            )


def _fetch_job_signals(since: str, signal_type: str, limit: int) -> list[dict[str, Any]]:
    sql = ("SELECT fingerprint, job_title, company, keywords_json, signal_type, "
           "last_seen_at, excerpt FROM job_signals WHERE 1=1")
    params: list[Any] = []
    if since:
        sql += " AND last_seen_at >= %s"
        params.append(since)
    if signal_type:
        sql += " AND signal_type = %s"
        params.append(signal_type)
    sql += " ORDER BY last_seen_at DESC LIMIT %s"
    params.append(limit)
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            return _fetch_dicts(cur, sql, tuple(params))


def _json_or(value: Any, fallback: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return fallback
    return value if value is not None else fallback


# ---------------------------------------------------------------------------
# 读工具（全部强制鉴权）
# ---------------------------------------------------------------------------

@mcp.tool()
def decision_today(token: str, actor: str) -> dict[str, Any]:
    """今日推荐列表（按总分降序）。每条含 fingerprint/岗位/公司/分数/分档/试单人，
    fingerprint 可直接用于 decision_command / decision_evidence_supply。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    items = []
    for rec in _fetch_today(actor):
        reasons = _json_or(rec.get("reasons_json"), {})
        items.append({
            "rec_id": rec.get("id"),
            "fingerprint": rec.get("job_signal_fingerprint", ""),
            "job_title": rec.get("job_title", ""),
            "company": rec.get("company", ""),
            "total_score": float(rec.get("total_score") or 0),
            "action": rec.get("action", ""),
            "confidence_band": rec.get("confidence_band", ""),
            "evidence_coverage": float(rec.get("evidence_coverage") or 0),
            "policy_version": rec.get("policy_version", ""),
            "dimensions": (reasons or {}).get("dimensions", []),
            "trial_candidates": _json_or(rec.get("trial_candidates_json"), []),
        })
    return {"ok": True, "consultant": actor, "count": len(items), "items": items}


@mcp.tool()
def decision_engagements(token: str, actor: str, state: str = "") -> dict[str, Any]:
    """我的承接列表（投影）。每行附 legal_commands——当前状态下可执行的命令，
    agent 据此决定下一步（watch/accept/dismiss/release/complete）。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        rows = store.list_engagements(actor)
    items = []
    for row in rows:
        if state and row.get("state") != state:
            continue
        items.append({
            "fingerprint": row.get("opportunity_id", ""),
            "state": row.get("state", ""),
            "state_version": row.get("state_version"),
            "last_action_at": _stringify(row.get("last_action_at")),
            "expires_at": _stringify(row.get("expires_at")),
            "legal_commands": _legal_commands(row.get("state", ""),
                                              cooled_until=row.get("expires_at")),
        })
    counts: dict[str, int] = {}
    for row in rows:
        counts[row.get("state", "")] = counts.get(row.get("state", ""), 0) + 1
    return {"ok": True, "consultant": actor, "count": len(items),
            "state_counts": counts, "watch_cap": sm.watch_cap(), "items": items}


@mcp.tool()
def decision_timeline(token: str, actor: str, fingerprint: str) -> dict[str, Any]:
    """单个机会的事件时间线 + 结果观察（账本原样，含 CORRECTION 纠错事件）。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        events = store.list_events(actor, fingerprint)
        outcomes = store.outcome_events_for(actor, fingerprint)
        engagement = store.get_engagement(actor, fingerprint) or {}
    slim = [{
        "seq": e.get("seq"),
        "event_type": e.get("event_type", ""),
        "previous_state": e.get("previous_state", ""),
        "next_state": e.get("next_state", ""),
        "reason_code": e.get("reason_code", ""),
        "actor": e.get("actor", ""),
        "metadata": e.get("metadata_json") or e.get("metadata") or {},
        "occurred_at": _stringify(e.get("occurred_at")),
    } for e in events]
    obs = [{
        "stage": o.get("stage", ""),
        "value": o.get("value_json") or o.get("value"),
        "scope": o.get("scope", ""),
        "source": o.get("source", ""),
        "observed_at": _stringify(o.get("observed_at")),
    } for o in outcomes]
    return {
        "ok": True, "consultant": actor, "fingerprint": fingerprint,
        "state": engagement.get("state", "NEW"),
        "legal_commands": _legal_commands(engagement.get("state", "NEW"),
                                          cooled_until=engagement.get("expires_at")),
        "events": slim, "outcomes": obs,
    }


@mcp.tool()
def decision_outcomes(token: str, actor: str) -> dict[str, Any]:
    """我的全部结果观察（调权学习的数据源；最新在后）。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        outcomes = store.consultant_outcomes(actor)
    items = [{
        "fingerprint": o.get("opportunity_id", ""),
        "stage": o.get("stage", ""),
        "value": o.get("value_json") or o.get("value"),
        "scope": o.get("scope", ""),
        "observed_at": _stringify(o.get("observed_at")),
    } for o in outcomes]
    return {"ok": True, "consultant": actor, "count": len(items), "items": items}


@mcp.tool()
def decision_policy(token: str, actor: str) -> dict[str, Any]:
    """当前生效策略与手工调权解锁进度。生效优先级 manual_override > auto_active
    > baseline；解锁=连续 2 轮不满意（ignore/dismiss 带原因、反馈≤2、release 归因）。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        progress = _unlock_state(store, actor)
        baseline = policy_rules.current_policy(db.current_weights(seed=False))
        resolved = personalizer.resolve(store, actor, baseline)
        shadows = store.list_policies(actor, kind="auto_shadow", status="shadow")
    return {
        "ok": True, "consultant": actor,
        "effective": resolved,
        "baseline": baseline,
        "shadow_pending": shadows[-1]["policy_version"] if shadows else "",
        "manual_tuning": {
            "unlocked": progress["unlocked"],
            "streak": progress["streak"],
            "rounds_to_go": progress["rounds_to_go"],
            "hint": "连续 2 轮反馈不满意，已开放手工调权" if progress["unlocked"]
                    else f"还需 {progress['rounds_to_go']} 轮不满意反馈解锁手工调权",
        },
    }


@mcp.tool()
def decision_evidence_supply(token: str, actor: str, fingerprint: str,
                             jd_text: str = "") -> dict[str, Any]:
    """供给证据（evidence-1.0 契约，不脱敏）：某岗位信号下的候选人供给——
    hits/通过率/Top3 试单人（含 phone/email 原文，可直接联系）。"""
    if (e := _auth(token, actor)):
        return e
    signal = _fetch_signal(fingerprint)
    if not signal:
        return _err(f"信号不存在: {fingerprint}", "not_found")
    candidates = _fetch_supply_candidates()
    return evidence.build_supply_evidence(signal, candidates, now=_now(), jd_text=jd_text)


@mcp.tool()
def decision_job_signals(token: str, actor: str, since: str = "",
                         signal_type: str = "", limit: int = 200) -> dict[str, Any]:
    """job_signals FactSource（evidence-1.0，excerpt 原文透传）。since 形如
    2026-08-01；signal_type 如 heating/new。"""
    if (e := _auth(token, actor)):
        return e
    limit = max(1, min(int(limit), 1000))
    rows = _fetch_job_signals(since, signal_type, limit)
    return evidence.build_job_signals_factsource(
        rows, now=_now(), since=since, signal_type=signal_type)


@mcp.tool()
def decision_replay_check(token: str, actor: str) -> dict[str, Any]:
    """只读审计：从我的事件账本重建承接投影，与已存投影比对，返回不一致项
    （验证事件溯源可回放性；不写任何数据）。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        projection = rebuild_projection(store, consultant_id=actor)
        stored = {row["opportunity_id"]: row.get("state", "") for row in store.list_engagements(actor)}
    mismatches = []
    for (cid, opp), row in sorted(projection.items()):
        current = stored.get(opp)
        if current != row["state"]:
            mismatches.append({"fingerprint": opp, "replayed": row["state"], "stored": current})
    for opp, current in sorted(stored.items()):
        if (actor, opp) not in projection:
            mismatches.append({"fingerprint": opp, "replayed": None, "stored": current})
    return {"ok": True, "consultant": actor, "replayed": len(projection),
            "stored": len(stored), "mismatches": mismatches}


# ---------------------------------------------------------------------------
# 写工具（操作逻辑与 HTTP app 完全一致；全部强制鉴权）
# ---------------------------------------------------------------------------

@mcp.tool()
def decision_command(token: str, actor: str, command: str, fingerprint: str,
                     reason_code: str = "", outcome_summary: str = "",
                     idempotency_key: str = "") -> dict[str, Any]:
    """执行承接命令（5 个顾问命令：watch/accept/dismiss/release/complete）。

    与 HTTP /command/* 同一套逻辑：状态机强约束 + 自动补链 + 幂等键去重 +
    关注位上限 + dismiss/release 必填原因。系统命令（recommend/expire）不开放。
    重复提交同一 idempotency_key 返回首次结果（already=True），不产生重复事件。
    """
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    if command in SYSTEM_COMMANDS:
        return _err(f"{command} 是系统命令，仅日推/过期扫描可触发", "system_command_forbidden",
                    legal_commands=CONSULTANT_COMMANDS)
    if command not in CONSULTANT_COMMANDS:
        return _err(f"未知命令: {command}", "unknown_command",
                    legal_commands=CONSULTANT_COMMANDS)
    try:
        with _store_ctx() as store:
            result = decision_commands.execute_command(
                store, command,
                consultant_id=actor,
                opportunity_id=fingerprint,
                idempotency_key=idempotency_key,
                reason_code=reason_code,
                outcome_summary=outcome_summary,
                actor=actor,
            )
            engagement = store.get_engagement(actor, fingerprint) or {}
        result.pop("events", None)
        result["legal_commands"] = _legal_commands(
            result.get("state", ""), cooled_until=engagement.get("expires_at"))
        return result
    except sm.CommandError as exc:
        with _store_ctx() as store:
            engagement = store.get_engagement(actor, fingerprint) or {"state": "NEW"}
        return _err(str(exc), "illegal_command",
                    state=engagement.get("state", "NEW"),
                    legal_commands=_legal_commands(engagement.get("state", "NEW"),
                                                   cooled_until=engagement.get("expires_at")))


@mcp.tool()
def decision_record_outcome(token: str, actor: str, fingerprint: str, stage: str,
                            value: dict, scope: str = "consultant_scoped",
                            idempotency_key: str = "") -> dict[str, Any]:
    """录入结果观察（数据反馈闭环）。stage 如 面试/Offer/入职/关闭/反馈；
    value 为 JSON（如 {"rating": 4, "note": "…"}）。同 stage 重复录入不同值
    不改历史，账本追加 CORRECTION 事件（与 HTTP /outcome 同一逻辑）。
    结果是个人自动调权（EMA）的奖励信号源。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    try:
        with _store_ctx() as store:
            return decision_commands.record_outcome(
                store,
                consultant_id=actor,
                opportunity_id=fingerprint,
                stage=stage,
                value=value,
                scope=scope,
                source="agent",
                recorded_by=actor,
                idempotency_key=idempotency_key,
            )
    except sm.CommandError as exc:
        return _err(str(exc), "invalid_outcome")


@mcp.tool()
def decision_save_weights(token: str, actor: str, weights: dict,
                          note: str = "") -> dict[str, Any]:
    """手工调权（门禁与 HTTP /weights 一致）：默认锁定，连续 2 轮不满意解锁；
    五维权重齐全、单维 ∈ [0.05, 0.60]、和 ≈1（不归一会自动归一并标记）；
    落 manual_override active 版本并接管排序，旧手工版本转 superseded。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        progress = _unlock_state(store, actor)
    if not progress["unlocked"]:
        return _err("手工调权未解锁", "locked",
                    rounds_to_go=progress["rounds_to_go"],
                    hint=f"还需 {progress['rounds_to_go']} 轮不满意反馈解锁手工调权")
    from decision.signal_scorer import DIMENSION_REGISTRY

    expected = set(DIMENSION_REGISTRY)
    actual = set(weights)
    if actual != expected:
        return _err("维度不匹配", "dimension_mismatch",
                    unknown=sorted(actual - expected), missing=sorted(expected - actual))
    try:
        clean = {}
        for name, value in weights.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
                return _err(f"权重 {name} 必须是 0 到 1 的数值", "invalid_weight")
            clean[name] = float(value)
        total = sum(clean.values())
        if total <= 0:
            return _err("权重总和必须大于 0", "invalid_weight")
        normalized = abs(total - 1.0) > 0.01
        if normalized:
            clean = {name: value / total for name, value in clean.items()}
        personalizer.validate_weights(clean)
    except ValueError as exc:
        return _err(str(exc), "invalid_weight")
    now = _now()
    with _store_ctx() as store:
        for old in store.list_policies(actor, kind="manual_override", status="active"):
            store.set_policy_status(old["policy_version"], "superseded")
        version = f"manual-{actor}-{now.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
        store.save_policy({
            "policy_version": version,
            "consultant_id": actor,
            "kind": "manual_override",
            "status": "active",
            "weights": clean,
            "bounds": {k: list(v) for k, v in personalizer.DEFAULT_BOUNDS.items()},
            "parent_version": "",
            "metadata": {"manual_tuning_unlocked": True,
                         "trigger": note or "两轮不满意触发手工面板",
                         "changed_by": actor, "via": "mcp"},
            "activated_at": now,
            "created_at": now,
        })
    return {"ok": True, "version": version, "kind": "manual_override",
            "weights": clean, "normalized": normalized,
            "hint": "decision_rollback 可随时回滚 baseline"}


@mcp.tool()
def decision_rollback(token: str, actor: str, reason: str = "") -> dict[str, Any]:
    """手工覆盖一键回滚：active 的 manual_override 置 rolled_back，
    生效策略按优先级回落（auto_active > baseline）。无生效手工版本时返回 ok=False。"""
    if (e := _auth(token, actor)):
        return e
    actor = actor.strip()
    with _store_ctx() as store:
        result = personalizer.rollback_manual(
            store, actor, reason=reason or "agent 触发回滚 baseline")
    return result


def main() -> None:
    """fail-closed 启动闸门：未配置 TTC_DECISION_MCP_TOKEN 拒绝服务。"""
    if not _env_token():
        print("TTC_DECISION_MCP_TOKEN 未配置——按强制鉴权纪律拒绝启动。"
              "请在 MCP 注册 env 中配置共享令牌。", file=sys.stderr)
        sys.exit(2)
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
