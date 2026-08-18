"""对外证据供给（开发文档 v2.0 §8/§9，决策③④）——只读 FactSource，供 Felix 线与 agent 插件消费。

契约：schema_version=evidence-1.0，source=braintex。
- /evidence/supply：供给证据（hits、pass_score、Top3 试单人含联系方式、信号摘要）——
  补齐 Felix 线 PRD 中「候选人资源证据」维度（PRD 该维度显示 UNKNOWN）。
- /evidence/job-signals：job_signals FactSource 输出，Felix 线直接消费，不重复采集。

数据纪律（2026-08-05 用户拍板，覆盖 §14）：**不脱敏**——内部自用接口，候选人
phone/email 原文出证据，excerpt 原文透传；访问控制由强制鉴权负责（RELOOP_API_TOKEN），
不靠打码。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from decision.trial_picker import PASS_SCORE, pick_trial, score_pool, supply_hits

SCHEMA_VERSION = "evidence-1.0"
SOURCE = "braintex"


def _signal_summary(signal: dict[str, Any]) -> dict[str, Any]:
    keywords = signal.get("keywords")
    if keywords is None:
        raw = signal.get("keywords_json")
        if isinstance(raw, str):
            import json

            try:
                keywords = json.loads(raw)
            except ValueError:
                keywords = []
        else:
            keywords = raw or []
    return {
        "signal_type": signal.get("signal_type", ""),
        "last_seen_at": str(signal.get("last_seen_at") or ""),
        "keywords": [k for k in keywords if isinstance(k, str)],
    }


def build_supply_evidence(
    signal: dict[str, Any],
    candidates: list[dict[str, Any]],
    *,
    now: datetime,
    jd_text: str = "",
) -> dict[str, Any]:
    """供给证据契约（§8 JSON 样例的构造器）。candidates 只读，个人信息原文透出（不脱敏）。"""
    text = jd_text or (
        f"岗位：{signal.get('job_title') or ''}\n"
        f"关键词：{' '.join(_signal_summary(signal)['keywords'])}"
    )
    scored = score_pool(text, candidates)
    top = pick_trial(scored)
    distribution = {
        "scored": len(scored),
        "pass": supply_hits(scored),
        "max": scored[0]["score"] if scored else 0.0,
    }
    return {
        "fingerprint": signal.get("fingerprint", ""),
        "as_of": now.replace(microsecond=0).isoformat(),
        "supply": {
            "hits": distribution["pass"],
            "pass_score": PASS_SCORE,
            "distribution": distribution,
            "top": [
                {"name": t["name"], "score": t["score"],
                 "evidence": list(t["evidence"]),
                 "fingerprint": t["fingerprint"],
                 "phone": t.get("phone") or "",
                 "email": t.get("email") or ""}
                for t in top
            ],
        },
        "signal": _signal_summary(signal),
        "source": SOURCE,
        "schema_version": SCHEMA_VERSION,
    }


def build_job_signals_factsource(
    rows: list[dict[str, Any]],
    *,
    now: datetime,
    since: str = "",
    signal_type: str = "",
) -> dict[str, Any]:
    """job_signals FactSource 契约输出（决策④）。行数据只读透传公开字段，excerpt 原文。"""
    items = []
    for row in rows:
        summary = _signal_summary(row)
        items.append({
            "fingerprint": row.get("fingerprint", ""),
            "job_title": row.get("job_title") or "",
            "company": row.get("company") or "",
            "signal_type": summary["signal_type"],
            "keywords": summary["keywords"],
            "excerpt": row.get("excerpt") or "",
            "last_seen_at": summary["last_seen_at"],
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "source": SOURCE,
        "as_of": now.replace(microsecond=0).isoformat(),
        "filter": {"since": since, "type": signal_type},
        "count": len(items),
        "items": items,
    }


_TOP_FIELDS = {"name", "score", "evidence", "fingerprint", "phone", "email"}


def validate_supply_contract(payload: dict[str, Any]) -> list[str]:
    """Felix 侧消费前校验：返回违规列表（空=合规）。契约测试与联调共用。"""
    errors: list[str] = []
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append("schema_version 不是 evidence-1.0")
    if payload.get("source") != SOURCE:
        errors.append("source 不是 braintex")
    for key in ("fingerprint", "as_of", "supply", "signal"):
        if key not in payload:
            errors.append(f"缺字段 {key}")
    supply = payload.get("supply") or {}
    for key in ("hits", "pass_score", "top"):
        if key not in supply:
            errors.append(f"supply 缺字段 {key}")
    for person in supply.get("top") or []:
        if set(person) - _TOP_FIELDS:
            errors.append(f"top 含越界字段: {sorted(set(person) - _TOP_FIELDS)}")
    return errors
