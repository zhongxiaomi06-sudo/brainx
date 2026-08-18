"""决策引擎（开发文档 v2.0 §5）——共用打分骨架的本侧实现。

链路：硬约束过滤 → 特征计算（5 维）→ 策略评分 → coverage 分档 → 固定 tie-breaker 排序。

关键纪律：
- 缺失维度不静默当 0：只对有证据维度求加权平均，分母=可用权重之和，
  evidence_coverage = 可用权重之和 / 总权重（§5.3）。现有 score_signal 强制
  全维权重，故先全维打分取每维 score，再按可用维重算（可行性验证已固化）。
- coverage < 0.50 强制 OBSERVE；0.50–0.70 最多 RECOMMEND_WATCH。
- confidence 只出 LOW/MEDIUM/HIGH band，不输出伪概率。
- tie-breaker 固定：score desc → coverage desc → freshness desc → fingerprint asc。
- clock 必须注入（now 参数化），禁止直接读系统时间，保证回放稳定。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Callable

from decision.signal_scorer import _SALARY_RE, _parse_time, score_signal

ACTIONS = ("RECOMMEND_ACCEPT", "RECOMMEND_WATCH", "OBSERVE", "EXCLUDE")
CONFIDENCE_BANDS = ("LOW", "MEDIUM", "HIGH")
ACTIVE_SIGNAL_TYPES = ("new", "heating", "active")

DEFAULT_THRESHOLDS = {
    "observe_below": 0.50,   # coverage 低于此值强制 OBSERVE
    "watch_below": 0.70,     # coverage 低于此值最多 RECOMMEND_WATCH
    "accept_score": 60.0,    # RECOMMEND_ACCEPT 的分数门槛
    "window_days": 7,        # 岗位活跃窗口
}


def available_dimensions(signal: dict[str, Any]) -> set[str]:
    """有证据才算可用维度（§5.3 缺失维度判定）。

    urgency/supply_match 总会执行（文本扫描与供给池打分）；freshness 需时间可解析；
    salary_fit 需薪资区间可解析；client_history 冷启动无数据时不可用（不静默中性 50）。
    """
    available = {"urgency", "supply_match"}
    if _parse_time(signal.get("last_seen_at")):
        available.add("freshness")
    text = f"{signal.get('job_title') or ''} {signal.get('excerpt') or ''}"
    if _SALARY_RE.search(text):
        available.add("salary_fit")
    if signal.get("client_history"):
        available.add("client_history")
    return available


def score_with_coverage(
    signal: dict[str, Any],
    weights: dict[str, float],
    supply_hits: int,
    *,
    now: datetime,
    thresholds: dict[str, float] | None = None,
) -> dict[str, Any]:
    """5 维打分 + coverage 分档，输出 action/confidence_band/evidence_coverage。"""
    th = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    available = available_dimensions(signal)
    coverage = sum(float(weights[k]) for k in available) / sum(float(v) for v in weights.values())
    base = score_signal(signal, weights, supply_hits, now=now)
    dims = base["dimensions"]
    if available:
        denom = sum(float(weights[d["name"]]) for d in dims if d["name"] in available)
        score = sum(d["score"] * float(weights[d["name"]]) for d in dims if d["name"] in available) / denom
        if signal.get("signal_type") == "cooling":
            score *= 0.5
        score = round(max(0.0, min(100.0, score)), 1)
    else:
        score = 0.0
    if coverage < th["observe_below"]:
        action = "OBSERVE"
    elif coverage < th["watch_below"]:
        action = "RECOMMEND_WATCH"
    else:
        action = "RECOMMEND_ACCEPT" if score >= th["accept_score"] else "RECOMMEND_WATCH"
    confidence = "HIGH" if coverage >= 0.9 else ("MEDIUM" if coverage >= th["watch_below"] else "LOW")
    freshness = next((d["score"] for d in dims if d["name"] == "freshness"), 0.0)
    return {
        "action": action,
        "confidence_band": confidence,
        "evidence_coverage": round(coverage, 3),
        "total_score": score,
        "freshness_score": freshness,
        "available_dimensions": sorted(available),
        "reasons": {"total": score, "dimensions": dims, "evidence_coverage": round(coverage, 3)},
    }


def hard_constraint_violation(
    signal: dict[str, Any],
    *,
    now: datetime,
    blocked_fingerprints: set[str],
    thresholds: dict[str, float] | None = None,
) -> str:
    """§5.2 硬约束；返回违规原因（空串=通过）。违规即 EXCLUDE，不进推荐列表。"""
    th = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    fingerprint = signal.get("fingerprint") or ""
    if not fingerprint or not (signal.get("job_title") or "").strip():
        return "missing_key_fields"
    if signal.get("signal_type") not in ACTIVE_SIGNAL_TYPES:
        return "inactive_signal_type"
    last_seen = _parse_time(signal.get("last_seen_at"))
    if not last_seen or now - last_seen > timedelta(days=th["window_days"]):
        return "stale_signal"
    if fingerprint in blocked_fingerprints:
        return "engagement_state"
    return ""


def decide(
    signals: list[dict[str, Any]],
    weights: dict[str, float],
    supply_fn: Callable[[dict[str, Any]], tuple[int, list[dict[str, Any]]]],
    *,
    now: datetime,
    policy_version: str,
    blocked_fingerprints: set[str] | None = None,
    thresholds: dict[str, float] | None = None,
) -> dict[str, Any]:
    """对一组信号产出稳定排序的推荐决策。

    supply_fn(signal) -> (supply_hits, trial_candidates)。返回：
    rows（按固定 tie-breaker 排序）+ excluded（审计用，含原因）。
    排序键构成全序（fingerprint 唯一兜底），同快照同策略版本重放逐字节一致。
    """
    blocked = blocked_fingerprints or set()
    rows: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for signal in signals:
        fingerprint = signal.get("fingerprint") or ""
        violation = hard_constraint_violation(
            signal, now=now, blocked_fingerprints=blocked, thresholds=thresholds,
        )
        if violation:
            excluded.append({"fingerprint": fingerprint, "reason": violation,
                             "job_title": signal.get("job_title") or ""})
            continue
        hits, trial = supply_fn(signal)
        scored = score_with_coverage(signal, weights, hits, now=now, thresholds=thresholds)
        rows.append({
            "fingerprint": fingerprint,
            "job_title": signal.get("job_title") or "",
            "company": signal.get("company") or "",
            "signal_type": signal.get("signal_type") or "",
            "total_score": scored["total_score"],
            "action": scored["action"],
            "confidence_band": scored["confidence_band"],
            "evidence_coverage": scored["evidence_coverage"],
            "freshness_score": scored["freshness_score"],
            "reasons": scored["reasons"],
            "trial_candidates": trial,
            "supply_hits": hits,
            "policy_version": policy_version,
        })
    rows.sort(key=lambda r: (-r["total_score"], -r["evidence_coverage"],
                             -r["freshness_score"], r["fingerprint"]))
    return {"rows": rows, "excluded": excluded, "policy_version": policy_version}
