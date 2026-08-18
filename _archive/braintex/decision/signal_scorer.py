"""Deterministic five-dimension scoring for job signals."""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import math
import re
from datetime import datetime, timezone
from typing import Any

DIMENSION_REGISTRY = {
    "freshness": {"desc": "信号新鲜度"},
    "salary_fit": {"desc": "薪资信息完整度"},
    "urgency": {"desc": "岗位紧迫度"},
    "supply_match": {"desc": "人才库供给匹配"},
    "client_history": {"desc": "客户历史转化"},
}

_SALARY_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*[kK]")
_URGENT = ("急招", "急聘", "尽快", "ASAP", "asap", "本周到岗", "立即到岗", "刚需")


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    if value is not None and str(value).strip():
        text = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
            return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            try:
                return datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                return None
    return None


def _salary(excerpt: str) -> tuple[float, str]:
    match = _SALARY_RE.search(excerpt or "")
    if not match:
        return 40.0, "薪资信息未完整披露"
    lo, hi = float(match.group(1)), float(match.group(2))
    if hi <= lo or hi > 200:
        return 30.0, f"薪资区间 {lo:g}-{hi:g}k 不合理"
    bandwidth = hi - lo
    score = 90.0 if 10 <= bandwidth <= 30 else 60.0
    return score, f"薪资 {lo:g}-{hi:g}k 带宽{bandwidth:g}k"


def score_signal(
    signal: dict[str, Any],
    weights: dict[str, float],
    supply_hits: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    unknown = [name for name in weights if name not in DIMENSION_REGISTRY]
    if unknown:
        raise ValueError(f"未知维度: {unknown[0]}")
    missing = [name for name in DIMENSION_REGISTRY if name not in weights]
    if missing:
        raise ValueError(f"缺少维度: {missing[0]}")
    for name in DIMENSION_REGISTRY:
        value = weights[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
            raise ValueError(f"维度权重无效: {name}")
    if not math.isclose(sum(float(weights[name]) for name in DIMENSION_REGISTRY), 1.0, abs_tol=0.02):
        raise ValueError("维度权重总和必须接近 1")
    now = (now or datetime.now()).replace(tzinfo=None)
    last_seen = _parse_time(signal.get("last_seen_at"))
    days = max(0.0, (now - last_seen).total_seconds() / 86400) if last_seen else None
    freshness = max(0.0, 100.0 - 15.0 * max(0.0, days - 1.0)) if days is not None else 0.0
    text = f"{signal.get('job_title') or ''} {signal.get('excerpt') or ''}"
    urgent_hits = [word for word in _URGENT if word in text]
    salary_score, salary_reason = _salary(str(signal.get("excerpt") or ""))
    dimensions = [
        ("freshness", freshness, f"信号 {days:.1f} 天前活跃" if days is not None else "信号时间缺失或无法解析"),
        ("salary_fit", salary_score, salary_reason),
        (
            "urgency",
            100.0 if urgent_hits else 30.0,
            f"命中紧急词：{'/'.join(urgent_hits)}" if urgent_hits else "未命中紧急词",
        ),
        ("supply_match", min(100.0, max(0, supply_hits) * 10.0), f"人才库命中 {supply_hits} 人可试单"),
        ("client_history", 50.0, "冷启动默认中性（无历史转化数据）"),
    ]
    if signal.get("signal_type") == "heating":
        dimensions[2] = ("urgency", min(100.0, dimensions[2][1] + 20.0), dimensions[2][2] + "；信号状态：heating")
    elif signal.get("signal_type") == "cooling":
        dimensions[2] = ("urgency", dimensions[2][1], dimensions[2][2] + "；信号状态：cooling，总分减半")
    result_dimensions = []
    total = 0.0
    for name, score, reason in dimensions:
        weight = float(weights.get(name, 0.0))
        weighted = score * weight
        total += weighted
        result_dimensions.append({
            "name": name,
            "score": round(score, 1),
            "weight": weight,
            "weighted": round(weighted, 1),
            "reason": reason,
        })
    if signal.get("signal_type") == "cooling":
        total *= 0.5
        for item in result_dimensions:
            item["weighted"] = round(float(item["weighted"]) * 0.5, 1)
    return {"total": round(max(0.0, min(100.0, total)), 1), "dimensions": result_dimensions}
