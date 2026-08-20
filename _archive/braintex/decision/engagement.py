"""承接生命周期状态机（开发文档 v2.0 §4）——纯领域逻辑，不碰 DB。

8 态：NEW → RECOMMENDED → VIEWED → WATCHED → ACCEPTED → COMPLETED
                └→ DISMISSED（冷却 30 天）   WATCHED → EXPIRED（90 天无有效动作）
                                           ACCEPTED → RELEASED（须填原因）

服务端强约束：
- EXPIRED 只允许从 WATCHED 进入；ACCEPTED 不得被 90 天规则静默退回。
- DISMISSED / RELEASED 必须带 reason_code。
- WATCHED 每顾问最多 WATCH_CAP 个（TTC_DECISION_WATCH_CAP，默认 10）。
- 冷却期内同 fingerprint 不再推荐；冷却结束可被系统重新推荐（DISMISSED→RECOMMENDED）。
- 未在文档状态图上的两个补充转移（2026-08-05 可行性验证报告 §6-2 确认需要）：
  WATCHED→DISMISSED（关注后仍可暂不考虑）、EXPIRED→RECOMMENDED（过期后可重新推荐）。
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

STATES = (
    "NEW", "RECOMMENDED", "VIEWED", "WATCHED",
    "ACCEPTED", "RELEASED", "COMPLETED", "DISMISSED", "EXPIRED",
)

TERMINAL_STATES = frozenset({"RELEASED", "COMPLETED"})

# 命令 → 目标状态。推荐位链路命令（watch/accept）允许从链路前序状态自动补链。
COMMAND_TARGET = {
    "recommend": "RECOMMENDED",   # 系统：日推生成（含冷却结束后的重新推荐）
    "view": "VIEWED",
    "watch": "WATCHED",
    "accept": "ACCEPTED",
    "dismiss": "DISMISSED",
    "release": "RELEASED",
    "complete": "COMPLETED",
    "expire": "EXPIRED",          # 系统：90 天规则
}

RECOMMEND_PATH = ("NEW", "RECOMMENDED", "VIEWED", "WATCHED", "ACCEPTED")

# 允许的直接（非补链）转移
DIRECT_TRANSITIONS = frozenset({
    ("NEW", "RECOMMENDED"),
    ("RECOMMENDED", "VIEWED"),
    ("RECOMMENDED", "WATCHED"),      # 卡片一键关注，视为已查看（补链事件由 commands 发出）
    ("RECOMMENDED", "DISMISSED"),
    ("VIEWED", "WATCHED"),
    ("VIEWED", "DISMISSED"),
    ("WATCHED", "DISMISSED"),        # 文档补充：关注后仍可暂不考虑
    ("WATCHED", "ACCEPTED"),
    ("WATCHED", "EXPIRED"),
    ("ACCEPTED", "RELEASED"),
    ("ACCEPTED", "COMPLETED"),
    ("DISMISSED", "RECOMMENDED"),    # 冷却结束后系统重新推荐
    ("EXPIRED", "RECOMMENDED"),      # 文档补充：过期后可重新推荐
})

EXPIRE_DAYS = 90
COOLDOWN_DAYS = 30
VALID_ACTIONS = frozenset({"view", "note", "accept", "release", "outcome"})  # 纯同步/重推不算


class CommandError(ValueError):
    """非法命令/状态转移。message 面向调用方，可安全回显。"""


def watch_cap() -> int:
    try:
        return max(1, int(os.getenv("TTC_DECISION_WATCH_CAP", "10")))
    except ValueError:
        return 10


def requires_reason(command: str) -> bool:
    return command in {"dismiss", "release"}


def plan_transition(state: str, command: str, *, reason_code: str = "",
                    now: datetime, cooled_until: datetime | None = None) -> list[str]:
    """计算 state 经 command 到达目标的补链事件序列（不含当前态）。

    返回要依次发出的事件目标状态列表；非法则抛 CommandError。
    """
    if command not in COMMAND_TARGET:
        raise CommandError(f"未知命令: {command}")
    target = COMMAND_TARGET[command]
    if state in TERMINAL_STATES:
        raise CommandError(f"{state} 是终态，不可再操作")
    if requires_reason(command) and not reason_code.strip():
        raise CommandError(f"{command} 必须填 reason_code")
    if state == target:
        raise CommandError(f"已处于 {target}")

    if command in {"watch", "accept"}:
        # 推荐位链路上的自动补链：RECOMMENDED 直接接单 → VIEWED/WATCHED 一并落账
        try:
            src = RECOMMEND_PATH.index(state)
            dst = RECOMMEND_PATH.index(target)
        except ValueError as exc:
            raise CommandError(f"非法状态转移: {state} → {target}") from exc
        if src >= dst:
            raise CommandError(f"非法状态转移: {state} → {target}")
        return list(RECOMMEND_PATH[src + 1: dst + 1])

    if command == "expire":
        if state != "WATCHED":
            raise CommandError("EXPIRED 只允许从 WATCHED 进入")
        return ["EXPIRED"]

    if command == "recommend" and state == "DISMISSED":
        if cooled_until and now < cooled_until:
            raise CommandError("冷却期内不得重新推荐")
        return ["RECOMMENDED"]

    if (state, target) in DIRECT_TRANSITIONS:
        return [target]
    raise CommandError(f"非法状态转移: {state} → {target}")


def cooldown_until(dismissed_at: datetime) -> datetime:
    return dismissed_at + timedelta(days=COOLDOWN_DAYS)


def is_recommendable(state: str, *, now: datetime, cooled_until: datetime | None = None) -> bool:
    """冷却期内 / 已承接完结的 fingerprint 不进推荐。"""
    if state in {"ACCEPTED", "COMPLETED"}:
        return False
    if state == "DISMISSED" and cooled_until and now < cooled_until:
        return False
    return True


def should_expire(state: str, *, last_action_at: datetime | None, now: datetime) -> bool:
    """90 天无有效动作过期：只允许 WATCHED → EXPIRED，ACCEPTED 永不静默退回。"""
    if state != "WATCHED" or last_action_at is None:
        return False
    return now - last_action_at >= timedelta(days=EXPIRE_DAYS)
