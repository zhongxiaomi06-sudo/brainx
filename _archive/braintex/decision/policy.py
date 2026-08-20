"""双轨调权的策略面（开发文档 v2.0 §6）——S3 先交付解锁状态计算，S4 补齐自动策略。

本模块：
- 不满意信号判定与「连续 2 轮不满意」解锁进度（§6.3），供 weights 页三态展示
  与 POST /weights 写入门禁使用；
- 当前生效策略解析（manual_override > auto_active > baseline），S4 的
  Personalizer/policy_versions 落地后只需扩展 resolve() 的数据源。
"""

from __future__ import annotations

import json
from typing import Any

from decision.db import SEED_WEIGHTS

UNSATISFIED_RELEASE_REASONS = {"推荐不准", "人选不对"}
UNLOCK_STREAK = 2


def is_unsatisfied(response: dict[str, Any]) -> bool:
    """不满意信号（§6.3，满足其一）：
    ignore/dismiss 带 reason_code；结果反馈评分 ≤2/5；release 归因推荐不准/人选不对。
    """
    rtype = response.get("type", "")
    if rtype in {"ignore", "dismiss"} and response.get("reason_code"):
        return True
    if rtype == "feedback":
        try:
            if float(response.get("score", 5)) <= 2:
                return True
        except (TypeError, ValueError):
            return False
    if rtype == "release" and response.get("reason_code") in UNSATISFIED_RELEASE_REASONS:
        return True
    return False


def is_satisfied(response: dict[str, Any]) -> bool:
    return response.get("type") in {"adopt", "accept"}


def unlock_progress(responses: list[dict[str, Any]]) -> dict[str, Any]:
    """连续 2 轮不满意解锁；穿插满意清零；非响应事件不参与计数（跨日有效）。"""
    streak = 0
    for response in responses:
        if is_satisfied(response):
            streak = 0
        elif is_unsatisfied(response):
            streak += 1
    return {
        "unlocked": streak >= UNLOCK_STREAK,
        "streak": streak,
        "rounds_to_go": max(0, UNLOCK_STREAK - streak),
    }


def responses_from_events(events: list[dict[str, Any]], outcomes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把账本事件 + 结果观察规整为按时间排序的「响应」序列（触发器输入）。"""
    responses: list[dict[str, Any]] = []
    for event in events:
        etype = event.get("event_type", "")
        mapping = {"ACCEPTED": "accept", "DISMISSED": "dismiss", "RELEASED": "release"}
        if etype not in mapping:
            continue
        responses.append({
            "type": mapping[etype],
            "reason_code": event.get("reason_code", ""),
            "at": event.get("occurred_at"),
        })
    for outcome in outcomes:
        value = outcome.get("value_json")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                value = {}
        if outcome.get("stage") == "反馈" or "rating" in (value or {}):
            responses.append({
                "type": "feedback",
                "score": (value or {}).get("rating", 5),
                "at": outcome.get("observed_at"),
            })
    responses.sort(key=lambda r: str(r.get("at") or ""))
    return responses


def current_policy(weights_row: dict[str, Any] | None) -> dict[str, Any]:
    """当前生效策略（S3：恒为 baseline；S4 接入 policy_versions 后扩展）。"""
    if weights_row:
        return {
            "kind": "baseline",
            "policy_version": f"baseline-{weights_row['version']}.0",
            "weights": weights_row["weights"],
        }
    return {"kind": "baseline", "policy_version": "baseline-1.0", "weights": dict(SEED_WEIGHTS)}
