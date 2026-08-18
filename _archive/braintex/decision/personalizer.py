"""Personalizer：个人自动策略学习（开发文档 v2.0 §6.2）——EMA/有界增量，先 Shadow 达标才 Active。

纪律：
- 只读本人事件/结果（consultant 隔离）；
- 样本不足（<20 有效决策事件 或 <5 条 consultant_scoped 结果观察）返回原策略，不更新；
- 新策略先 Shadow（并行打分不接管排序）；转 Active 需显式 promote 且全部门槛通过
  （样本量、离线回放不低于 baseline、版本校验：权重和≈1、单维∈bounds、更新幅度有界）；
- 1.0 不做强化学习；发现质量下降可回滚 baseline。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from decision.event_store import Store
from decision.signal_scorer import DIMENSION_REGISTRY

EMA_ALPHA = 0.2
MIN_EVENTS = 20
MIN_OUTCOMES = 5
DEFAULT_BOUNDS = {name: (0.05, 0.60) for name in DIMENSION_REGISTRY}


def validate_weights(weights: dict[str, float], bounds: dict[str, tuple[float, float]] | None = None) -> None:
    bounds = bounds or DEFAULT_BOUNDS
    if set(weights) != set(DIMENSION_REGISTRY):
        raise ValueError("维度集合不匹配")
    for name, value in weights.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} 非数值")
        lo, hi = bounds[name]
        if not lo <= float(value) <= hi:
            raise ValueError(f"{name}={value} 超出 bounds {bounds[name]}")
    if abs(sum(float(v) for v in weights.values()) - 1.0) > 0.02:
        raise ValueError("权重和必须 ≈1")


def ema_update(current: dict[str, float], reward: dict[str, float],
               bounds: dict[str, tuple[float, float]] | None = None) -> dict[str, float]:
    """有界 EMA 增量：w' = normalize(clip(w + α·(reward − w)))，幅度天然受 α 与 bounds 双重约束。"""
    bounds = bounds or DEFAULT_BOUNDS
    updated: dict[str, float] = {}
    for name in DIMENSION_REGISTRY:
        lo, hi = bounds[name]
        delta = EMA_ALPHA * (float(reward.get(name, 0.0)) - float(current[name]))
        updated[name] = min(hi, max(lo, float(current[name]) + delta))
    total = sum(updated.values())
    return {k: round(v / total, 6) for k, v in updated.items()}


def reward_from_outcomes(outcomes: list[dict[str, Any]]) -> dict[str, float]:
    """从结果观察提取奖励信号（1.0 简化版）：

    正向结果（面试通过/Offer/入职）多的阶段证明供给与时效维度有效 → 提高
    supply_match/freshness 目标分；负向（关闭/低评分）提高 client_history/urgency 权重目标。
    """
    positive = negative = 0
    for outcome in outcomes:
        stage = outcome.get("stage", "")
        value = outcome.get("value_json") or outcome.get("value") or {}
        if isinstance(value, dict) and value.get("rating") is not None:
            try:
                (positive, negative)[int(float(value["rating"]) <= 2)] += 1
                continue
            except (TypeError, ValueError):
                pass
        if stage in {"面试", "Offer", "入职"}:
            positive += 1
        elif stage in {"关闭"}:
            negative += 1
    total = positive + negative
    ratio = positive / total if total else 0.5
    return {
        "freshness": 0.5,
        "salary_fit": 0.5,
        "urgency": 0.3 + 0.4 * (1 - ratio),
        "supply_match": 0.3 + 0.6 * ratio,
        "client_history": 0.3 + 0.4 * (1 - ratio),
    }


def maybe_learn(store: Store, consultant_id: str, current: dict[str, float],
                *, now: datetime | None = None) -> dict[str, Any]:
    """样本门槛内则学习并落 Shadow 版本；不足则原样返回。只读本人数据。"""
    now = (now or datetime.now()).replace(tzinfo=None)
    events = [e for e in store.consultant_events(consultant_id) if e.get("event_type") != "CORRECTION"]
    if len(events) < MIN_EVENTS:
        return {"status": "insufficient_events", "weights": current, "events": len(events)}
    outcomes = [o for o in store.consultant_outcomes(consultant_id) if o.get("scope") == "consultant_scoped"]
    if len(outcomes) < MIN_OUTCOMES:
        return {"status": "insufficient_outcomes", "weights": current, "outcomes": len(outcomes)}
    learned = ema_update(current, reward_from_outcomes(outcomes))
    validate_weights(learned)
    parent = ""
    shadows = store.list_policies(consultant_id, kind="auto_shadow")
    if shadows:
        parent = shadows[-1]["policy_version"]
    version = f"auto-shadow-{now.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
    store.save_policy({
        "policy_version": version,
        "consultant_id": consultant_id,
        "kind": "auto_shadow",
        "status": "shadow",
        "weights": learned,
        "bounds": {k: list(v) for k, v in DEFAULT_BOUNDS.items()},
        "parent_version": parent,
        "metadata": {"events": len(events), "outcomes": len(outcomes), "alpha": EMA_ALPHA},
        "activated_at": None,
        "created_at": now,
    })
    return {"status": "shadow", "weights": learned, "policy_version": version}


def offline_replay_ok(recommendations: list[dict[str, Any]],
                      shadow_weights: dict[str, float],
                      baseline_weights: dict[str, float]) -> tuple[bool, dict[str, float]]:
    """离线回放门槛（§6.2）：用存量推荐的已存维度分，分别以 shadow/baseline 权重重算总分，
    shadow 平均总分不得低于 baseline（维度分是 FACT，权重重算是可回放 JUDGMENT）。
    """
    import json

    def rescore(dimensions: list[dict[str, Any]], weights: dict[str, float]) -> float:
        return sum(float(d.get("score", 0)) * float(weights.get(d.get("name", ""), 0)) for d in dimensions)

    baseline_scores: list[float] = []
    shadow_scores: list[float] = []
    for rec in recommendations:
        reasons = rec.get("reasons_json")
        if isinstance(reasons, str):
            try:
                reasons = json.loads(reasons)
            except ValueError:
                continue
        dims = (reasons or {}).get("dimensions") or []
        if not dims:
            continue
        baseline_scores.append(rescore(dims, baseline_weights))
        shadow_scores.append(rescore(dims, shadow_weights))
    if not baseline_scores:
        return False, {"pairs": 0}
    base_mean = sum(baseline_scores) / len(baseline_scores)
    shadow_mean = sum(shadow_scores) / len(shadow_scores)
    return shadow_mean >= base_mean, {
        "pairs": len(baseline_scores),
        "baseline_mean": round(base_mean, 2),
        "shadow_mean": round(shadow_mean, 2),
    }


def promote(store: Store, consultant_id: str, policy_version: str,
            *, recommendations: list[dict[str, Any]] | None = None,
            baseline_weights: dict[str, float], now: datetime | None = None) -> dict[str, Any]:
    """Shadow → Active：版本校验 + 离线回放不低于 baseline；通过后接管排序。

    原 auto_active（若有）转为 superseded。1.0 不做强化学习，Active 版本同样可回滚。
    """
    now = (now or datetime.now()).replace(tzinfo=None)
    shadows = [p for p in store.list_policies(consultant_id, kind="auto_shadow")
               if p["policy_version"] == policy_version and p["status"] == "shadow"]
    if not shadows:
        raise ValueError(f"shadow 版本不存在或已处理: {policy_version}")
    shadow = shadows[0]
    weights = shadow.get("weights_json") or shadow.get("weights")
    validate_weights(weights)
    ok, metrics = offline_replay_ok(recommendations or [], weights, baseline_weights)
    if not ok:
        raise ValueError(f"离线回放未达 baseline: {metrics}")
    for old in store.list_policies(consultant_id, kind="auto_active", status="active"):
        store.set_policy_status(old["policy_version"], "superseded")
    store.save_policy({
        "policy_version": policy_version.replace("auto-shadow", "auto-active", 1),
        "consultant_id": consultant_id,
        "kind": "auto_active",
        "status": "active",
        "weights": weights,
        "bounds": shadow.get("bounds_json") or shadow.get("bounds"),
        "parent_version": policy_version,
        "metadata": {"replay": metrics},
        "activated_at": now,
        "created_at": now,
    })
    store.set_policy_status(policy_version, "superseded")
    return {"status": "active", "policy_version": policy_version.replace("auto-shadow", "auto-active", 1),
            "replay": metrics}


def resolve(store: Store, consultant_id: str,
            baseline: dict[str, Any]) -> dict[str, Any]:
    """生效优先级（§6.1）：manual_override（active）> auto_active（active）> baseline。"""
    manual = store.list_policies(consultant_id, kind="manual_override", status="active")
    if manual:
        row = manual[-1]
        return {"kind": "manual_override", "policy_version": row["policy_version"],
                "weights": row.get("weights_json") or row.get("weights")}
    active = store.list_policies(consultant_id, kind="auto_active", status="active")
    if active:
        row = active[-1]
        return {"kind": "auto_active", "policy_version": row["policy_version"],
                "weights": row.get("weights_json") or row.get("weights")}
    return {"kind": "baseline", "policy_version": baseline["policy_version"],
            "weights": baseline["weights"]}


def rollback_manual(store: Store, consultant_id: str, *, reason: str = "回滚 baseline") -> dict[str, Any]:
    """手工覆盖一键回滚：active 的 manual_override 置 rolled_back，生效策略回落。"""
    manual = store.list_policies(consultant_id, kind="manual_override", status="active")
    if not manual:
        return {"ok": False, "detail": "无生效中的手工版本"}
    row = manual[-1]
    store.set_policy_status(row["policy_version"], "rolled_back", reason)
    return {"ok": True, "rolled_back": row["policy_version"]}
