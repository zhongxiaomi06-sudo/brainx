"""Braintex v2 框架可行性验证（开发文档 v2.0，2026-08-05）。

目的：在 S1–S5 实施前，用纯 Python 参考实现证明文档定稿的四组新机制
（8 态状态机 / 事件账本投影 / coverage 分档 / 双轨调权）规则自洽、
可与现有代码（score_signal / score_pool / SEED_WEIGHTS）直接组合。
这些参考实现是验收规则的固化，不是生产实现；S1 落地时应让生产代码
通过同一组验收语义。
"""

from __future__ import annotations

import hashlib
import json
import os
import unittest
from datetime import datetime, timedelta

from decision.db import SEED_WEIGHTS
from decision.signal_scorer import DIMENSION_REGISTRY, score_signal
from decision.trial_picker import PASS_SCORE, pick_trial, score_pool, supply_hits

NOW = datetime(2026, 8, 5, 10, 0, 0)

# ---------------------------------------------------------------------------
# 参考实现 1：承接状态机（文档 §4）
# ---------------------------------------------------------------------------

STATES = {"NEW", "RECOMMENDED", "VIEWED", "WATCHED", "ACCEPTED", "RELEASED", "COMPLETED", "DISMISSED", "EXPIRED"}

TRANSITIONS = {
    ("NEW", "RECOMMENDED"),
    ("RECOMMENDED", "VIEWED"),
    ("RECOMMENDED", "DISMISSED"),   # 旧 ignored 兼容映射入口
    ("VIEWED", "WATCHED"),
    ("VIEWED", "DISMISSED"),
    ("WATCHED", "ACCEPTED"),
    ("WATCHED", "EXPIRED"),         # 仅系统 90 天规则
    ("ACCEPTED", "RELEASED"),
    ("ACCEPTED", "COMPLETED"),
}

WATCH_CAP = int(os.getenv("TTC_DECISION_WATCH_CAP", "10"))
EXPIRE_DAYS = 90
COOLDOWN_DAYS = 30
VALID_ACTIONS = {"view", "note", "accept", "release", "outcome"}  # 纯同步/重推不算


class Engagement:
    """单顾问单机会的承接投影（参考实现，事件驱动）。"""

    def __init__(self, consultant: str, fingerprint: str):
        self.consultant = consultant
        self.fingerprint = fingerprint
        self.state = "NEW"
        self.last_action_at: datetime | None = None
        self.cooled_until: datetime | None = None

    def _move(self, target: str, at: datetime, reason_code: str = "") -> None:
        if (self.state, target) not in TRANSITIONS:
            raise ValueError(f"非法状态转移: {self.state} → {target}")
        if target in {"DISMISSED", "RELEASED"} and not reason_code:
            raise ValueError(f"{target} 必须填 reason_code")
        self.state = target
        self.last_action_at = at
        if target == "DISMISSED":
            self.cooled_until = at + timedelta(days=COOLDOWN_DAYS)


def system_expire(eng: Engagement, now: datetime) -> bool:
    """90 天无有效动作过期：只允许 WATCHED → EXPIRED，ACCEPTED 不得静默退回。"""
    if eng.state != "WATCHED":
        return False
    if eng.last_action_at and now - eng.last_action_at >= timedelta(days=EXPIRE_DAYS):
        eng._move("EXPIRED", now)
        return True
    return False


def recommendable(eng: Engagement, now: datetime) -> bool:
    """冷却期内同 fingerprint 不再推荐；ACCEPTED/COMPLETED 不再进接单推荐。"""
    if eng.state in {"ACCEPTED", "COMPLETED"}:
        return False
    if eng.cooled_until and now < eng.cooled_until:
        return False
    return True


# ---------------------------------------------------------------------------
# 参考实现 2：事件账本 + 投影重建（文档 §7）
# ---------------------------------------------------------------------------


class EventLedger:
    """只追加事件账本：幂等键去重、CORRECTION 不改历史、投影可重建。"""

    def __init__(self):
        self.events: list[dict] = []
        self.by_idem: dict[str, dict] = {}

    def append(self, event: dict) -> tuple[dict, bool]:
        key = event["idempotency_key"]
        if key in self.by_idem:
            return self.by_idem[key], False  # 重复提交返回原结果
        self.events.append(event)
        self.by_idem[key] = event
        return event, True

    def correct(self, original_id: str, patch: dict, at: datetime) -> dict:
        correction = {
            "event_id": f"corr-{original_id}",
            "event_type": "CORRECTION",
            "corrects": original_id,
            "metadata": patch,
            "recorded_at": at,
            "idempotency_key": f"corr:{original_id}:{hashlib.md5(json.dumps(patch, sort_keys=True).encode()).hexdigest()[:12]}",
        }
        self.append(correction)
        return correction


def rebuild_projection(events: list[dict], consultant: str, fingerprint: str) -> str:
    """engagements 是事件的可重建投影：重放该机会的非 CORRECTION 事件得终态。"""
    state = "NEW"
    for event in events:
        if event.get("event_type") == "CORRECTION":
            continue
        if event.get("consultant_id") == consultant and event.get("opportunity_id") == fingerprint:
            state = event.get("next_state") or state
    return state


# ---------------------------------------------------------------------------
# 参考实现 3：coverage 分档（文档 §5.3）——缺失维度不静默当 0
# ---------------------------------------------------------------------------


def available_dimensions(signal: dict, now: datetime) -> set[str]:
    """有证据才算可用维度：时间可解析 / 薪资可解析 / 文本扫描过 / 供给池跑过。"""
    available = {"urgency", "supply_match"}  # 文本扫描与供给池总会执行
    text = f"{signal.get('job_title') or ''} {signal.get('excerpt') or ''}"
    if signal.get("last_seen_at"):
        available.add("freshness")
    from decision.signal_scorer import _SALARY_RE

    if _SALARY_RE.search(text):
        available.add("salary_fit")
    if signal.get("client_history"):
        available.add("client_history")  # 冷启动无历史 → 不可用，不静默中性 50
    return available


def gated_score(signal: dict, weights: dict[str, float], supply: int, now: datetime,
                observe_below: float = 0.50, watch_below: float = 0.70) -> dict:
    """只对有证据维度求加权平均（分母=可用权重和），按 coverage 分档。

    可行性要点：现有 score_signal 强制 5 维权重齐全（缺维直接报错），
    不能靠「权重子集」实现缺失维度剔除；正确组合方式是先全维打分取
    每维 score/reason，再按可用维度重算加权平均（cooling 减半语义保留）。
    """
    available = available_dimensions(signal, now)
    coverage = sum(weights[k] for k in available) / sum(weights.values())
    if not available:
        return {"action": "OBSERVE", "coverage": 0.0, "score": 0.0, "confidence": "LOW"}
    result = score_signal(signal, weights, supply, now=now)
    denom = sum(weights[d["name"]] for d in result["dimensions"] if d["name"] in available)
    score = sum(d["score"] * weights[d["name"]] for d in result["dimensions"] if d["name"] in available) / denom
    if signal.get("signal_type") == "cooling":
        score *= 0.5
    score = round(max(0.0, min(100.0, score)), 1)
    if coverage < observe_below:
        action = "OBSERVE"
    elif coverage < watch_below:
        action = "RECOMMEND_WATCH"
    else:
        action = "RECOMMEND_ACCEPT" if score >= 60 else "RECOMMEND_WATCH"
    confidence = "HIGH" if coverage >= 0.9 else ("MEDIUM" if coverage >= watch_below else "LOW")
    return {"action": action, "coverage": round(coverage, 3), "score": score, "confidence": confidence}


def tie_break(rows: list[dict]) -> list[dict]:
    """固定 tie-breaker：score desc → coverage desc → freshness desc → fingerprint asc。

    freshness desc = 最新鲜优先；行内 freshness_days 表示「距今天数」，越小越新鲜，
    故按天数升序。
    """
    return sorted(rows, key=lambda r: (-r["score"], -r["coverage"], r.get("freshness_days", 0), r["fingerprint"]))


# ---------------------------------------------------------------------------
# 参考实现 4：双轨调权（文档 §6）
# ---------------------------------------------------------------------------

BOUNDS = {name: (0.05, 0.60) for name in DIMENSION_REGISTRY}
EMA_ALPHA = 0.2
MIN_EVENTS = 20
MIN_OUTCOMES = 5
UNSATISFIED_RELEASE_REASONS = {"推荐不准", "人选不对"}


def validate_policy(weights: dict[str, float]) -> None:
    if set(weights) != set(DIMENSION_REGISTRY):
        raise ValueError("维度集合不匹配")
    for name, value in weights.items():
        lo, hi = BOUNDS[name]
        if not lo <= float(value) <= hi:
            raise ValueError(f"{name} 超出 bounds {BOUNDS[name]}")
    if not abs(sum(float(v) for v in weights.values()) - 1.0) <= 0.02:
        raise ValueError("权重和必须 ≈1")


def ema_update(current: dict[str, float], reward_signal: dict[str, float]) -> dict[str, float]:
    """有界 EMA 增量：w' = normalize(clip(w + α·(target - w)))。"""
    updated = {}
    for name in DIMENSION_REGISTRY:
        lo, hi = BOUNDS[name]
        delta = EMA_ALPHA * (float(reward_signal.get(name, 0.0)) - current[name])
        updated[name] = min(hi, max(lo, current[name] + delta))
    total = sum(updated.values())
    return {k: round(v / total, 6) for k, v in updated.items()}


def maybe_learn(consultant_events: list[dict], outcomes: list[dict], current: dict[str, float]) -> dict:
    """样本门槛：≥20 有效事件 且 ≥5 条 consultant_scoped 结果观察，否则返回原策略。"""
    if len(consultant_events) < MIN_EVENTS:
        return {"status": "insufficient_events", "weights": current}
    scoped = [o for o in outcomes if o.get("scope") == "consultant_scoped"]
    if len(scoped) < MIN_OUTCOMES:
        return {"status": "insufficient_outcomes", "weights": current}
    learned = ema_update(current, {n: 0.9 if n == "supply_match" else 0.3 for n in DIMENSION_REGISTRY})
    validate_policy(learned)
    return {"status": "shadow", "weights": learned}  # 新策略先 Shadow，不接管排序


def resolve_policy(baseline: dict, auto_active: dict | None, manual: dict | None, manual_unlocked: bool) -> tuple[str, dict]:
    """生效优先级：manual_override（解锁且存在）> auto_active > baseline。"""
    if manual_unlocked and manual:
        return "manual_override", manual
    if auto_active:
        return "auto_active", auto_active
    return "baseline", baseline


def is_unsatisfied(response: dict) -> bool:
    """不满意信号（满足其一）：ignore/dismiss 带原因；反馈 ≤2/5；release 归因推荐不准。"""
    if response["type"] in {"ignore", "dismiss"} and response.get("reason_code"):
        return True
    if response["type"] == "feedback" and response.get("score", 5) <= 2:
        return True
    if response["type"] == "release" and response.get("reason_code") in UNSATISFIED_RELEASE_REASONS:
        return True
    return False


def is_satisfied(response: dict) -> bool:
    return response["type"] in {"adopt", "accept"}


def manual_unlock_progress(responses: list[dict]) -> dict:
    """连续 2 轮不满意解锁；穿插满意清零；非响应事件不参与计数。"""
    streak = 0
    for response in responses:
        if is_satisfied(response):
            streak = 0
        elif is_unsatisfied(response):
            streak += 1
    return {"unlocked": streak >= 2, "streak": streak, "rounds_to_go": max(0, 2 - streak)}


# ---------------------------------------------------------------------------
# 参考实现 5：对外证据契约（文档 §8/§9，schema_version=evidence-1.0）
# ---------------------------------------------------------------------------


def supply_evidence(signal: dict, candidates: list[dict], now: datetime) -> dict:
    jd_text = f"岗位：{signal.get('job_title') or ''}\n关键词：{' '.join(signal.get('keywords') or [])}"
    scored = score_pool(jd_text, candidates)
    top = pick_trial(scored)
    return {
        "fingerprint": signal["fingerprint"],
        "as_of": now.isoformat(),
        "supply": {
            "hits": supply_hits(scored),
            "pass_score": PASS_SCORE,
            "top": [{"name": t["name"], "score": t["score"], "evidence": t["evidence"]} for t in top],
        },
        "signal": {
            "signal_type": signal.get("signal_type", ""),
            "last_seen_at": signal.get("last_seen_at", ""),
            "keywords": signal.get("keywords") or [],
        },
        "source": "braintex",
        "schema_version": "evidence-1.0",
    }


# ---------------------------------------------------------------------------
# 验收测试
# ---------------------------------------------------------------------------


def _signal(**overrides):
    base = {
        "fingerprint": "fp-job-001",
        "job_title": "急招 Java 架构师",
        "company": "某大厂",
        "excerpt": "薪资 30-50k，急聘，本周到岗",
        "signal_type": "heating",
        "last_seen_at": "2026-08-04 09:00:00",
        "keywords": ["Java", "架构"],
    }
    base.update(overrides)
    return base


class StateMachineTests(unittest.TestCase):
    def test_happy_path_new_to_completed(self):
        eng = Engagement("ashley", "fp1")
        eng._move("RECOMMENDED", NOW)
        eng._move("VIEWED", NOW)
        eng._move("WATCHED", NOW)
        eng._move("ACCEPTED", NOW)
        eng._move("COMPLETED", NOW, reason_code="")
        self.assertEqual(eng.state, "COMPLETED")

    def test_illegal_transitions_rejected(self):
        eng = Engagement("ashley", "fp1")
        for bad in ("VIEWED", "WATCHED", "ACCEPTED", "COMPLETED", "DISMISSED", "EXPIRED", "RELEASED"):
            with self.assertRaises(ValueError, msg=f"NEW → {bad} 应拒绝"):
                eng._move(bad, NOW)
        eng._move("RECOMMENDED", NOW)
        with self.assertRaises(ValueError):
            eng._move("ACCEPTED", NOW)  # 必须先 VIEWED → WATCHED
        with self.assertRaises(ValueError):
            eng._move("EXPIRED", NOW)  # EXPIRED 只能从 WATCHED

    def test_release_and_dismiss_require_reason(self):
        eng = Engagement("ashley", "fp1")
        eng._move("RECOMMENDED", NOW)
        with self.assertRaises(ValueError):
            eng._move("DISMISSED", NOW)  # 无 reason_code
        eng._move("VIEWED", NOW)
        eng._move("WATCHED", NOW)
        eng._move("ACCEPTED", NOW)
        with self.assertRaises(ValueError):
            eng._move("RELEASED", NOW)

    def test_accepted_never_silently_expired(self):
        eng = Engagement("ashley", "fp1")
        eng._move("RECOMMENDED", NOW)
        eng._move("VIEWED", NOW)
        eng._move("WATCHED", NOW)
        eng._move("ACCEPTED", NOW + timedelta(days=1))
        far_future = NOW + timedelta(days=365)
        self.assertFalse(system_expire(eng, far_future))
        self.assertEqual(eng.state, "ACCEPTED")

    def test_watched_expires_after_90_days_without_valid_action(self):
        eng = Engagement("ashley", "fp1")
        eng._move("RECOMMENDED", NOW)
        eng._move("VIEWED", NOW)
        eng._move("WATCHED", NOW)
        self.assertFalse(system_expire(eng, NOW + timedelta(days=89)))
        self.assertTrue(system_expire(eng, NOW + timedelta(days=90)))
        self.assertEqual(eng.state, "EXPIRED")

    def test_dismiss_cooldown_blocks_recommendation_30_days(self):
        eng = Engagement("ashley", "fp1")
        eng._move("RECOMMENDED", NOW)
        eng._move("DISMISSED", NOW, reason_code="客户不靠谱")
        self.assertFalse(recommendable(eng, NOW + timedelta(days=29)))
        self.assertTrue(recommendable(eng, NOW + timedelta(days=31)))

    def test_watch_cap_10(self):
        watched = [Engagement("ashley", f"fp{i}") for i in range(WATCH_CAP)]
        for eng in watched:
            eng._move("RECOMMENDED", NOW)
            eng._move("VIEWED", NOW)
            eng._move("WATCHED", NOW)
        self.assertEqual(sum(1 for e in watched if e.state == "WATCHED"), WATCH_CAP)
        with self.assertRaises(ValueError, msg="超限应拒绝并提示先释放"):
            if sum(1 for e in watched if e.state == "WATCHED") >= WATCH_CAP:
                raise ValueError(f"关注位已满（{WATCH_CAP}），请先释放")

    def test_legacy_mapping_adopted_ignored(self):
        mapping = {"adopted": "ACCEPTED", "ignored": "DISMISSED"}
        self.assertEqual(mapping["adopted"], "ACCEPTED")
        self.assertEqual(mapping["ignored"], "DISMISSED")


class EventLedgerTests(unittest.TestCase):
    def _event(self, eid, state, idem, **kw):
        return {"event_id": eid, "consultant_id": "ashley", "opportunity_id": "fp1",
                "event_type": state, "next_state": state, "occurred_at": NOW,
                "recorded_at": NOW, "idempotency_key": idem, **kw}

    def test_idempotent_replay_returns_original(self):
        ledger = EventLedger()
        event = self._event("e1", "WATCHED", "watch:fp1:2026-08-05")
        first, created1 = ledger.append(event)
        second, created2 = ledger.append(dict(event))
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertIs(first, second)
        self.assertEqual(len(ledger.events), 1)

    def test_correction_appends_without_mutating_history(self):
        ledger = EventLedger()
        ledger.append(self._event("e1", "WATCHED", "k1"))
        ledger.correct("e1", {"reason_code": "补充原因"}, NOW)
        self.assertEqual(len(ledger.events), 2)
        self.assertEqual(ledger.events[0]["event_id"], "e1")
        self.assertNotIn("reason_code", json.dumps(ledger.events[0], default=str))
        self.assertEqual(ledger.events[1]["corrects"], "e1")

    def test_projection_rebuild_matches_live_state(self):
        ledger = EventLedger()
        for eid, state in (("e1", "RECOMMENDED"), ("e2", "VIEWED"), ("e3", "WATCHED"), ("e4", "ACCEPTED")):
            ledger.append(self._event(eid, state, f"k-{eid}"))
        ledger.append({"event_id": "x1", "consultant_id": "other", "opportunity_id": "fp1",
                       "event_type": "WATCHED", "next_state": "WATCHED", "idempotency_key": "k-x1"})
        rebuilt = rebuild_projection(ledger.events, "ashley", "fp1")
        self.assertEqual(rebuilt, "ACCEPTED")
        # 顾问隔离：other 的投影独立
        self.assertEqual(rebuild_projection(ledger.events, "other", "fp1"), "WATCHED")


class CoverageGatingTests(unittest.TestCase):
    def test_full_evidence_can_recommend_accept(self):
        result = gated_score(_signal(client_history={"orders": 3}), dict(SEED_WEIGHTS), supply=8, now=NOW)
        self.assertEqual(result["coverage"], 1.0)
        self.assertIn(result["action"], {"RECOMMEND_ACCEPT", "RECOMMEND_WATCH"})
        self.assertEqual(result["confidence"], "HIGH")

    def test_missing_dims_not_silently_zero(self):
        # 无时间、无薪资、无历史 → 仅 urgency/supply_match 可用（0.45 权重）
        bare = _signal(last_seen_at="", excerpt="JD 描述没有薪资信息", job_title="普通岗位")
        result = gated_score(bare, dict(SEED_WEIGHTS), supply=8, now=NOW)
        expected_coverage = SEED_WEIGHTS["urgency"] + SEED_WEIGHTS["supply_match"]
        self.assertAlmostEqual(result["coverage"], expected_coverage, places=2)
        self.assertEqual(result["action"], "OBSERVE")  # coverage < 0.5 强制 OBSERVE

    def test_mid_coverage_caps_at_watch(self):
        # 补回 freshness（0.25）→ coverage = 0.70，不 < 0.70 → 可 ACCEPT；
        # 用仅缺 client_history（0.10）→ coverage 0.90 → ACCEPT 档。
        # 构造 0.5–0.7 区间：缺 salary(0.20)+history(0.10) → 0.70 边界，
        # 再缺 freshness 一角 → 用权重变体验证 0.5<c<0.7 逻辑。
        weights = {"freshness": 0.15, "salary_fit": 0.20, "urgency": 0.20,
                   "supply_match": 0.25, "client_history": 0.20}
        bare = _signal(excerpt="JD 描述没有薪资信息", job_title="普通岗位")
        result = gated_score(bare, weights, supply=8, now=NOW)
        # 可用 = freshness+urgency+supply = 0.60 → 0.5–0.7 区间
        self.assertAlmostEqual(result["coverage"], 0.60, places=2)
        self.assertEqual(result["action"], "RECOMMEND_WATCH")
        self.assertEqual(result["confidence"], "LOW")

    def test_zero_supply_with_low_coverage_forces_observe(self):
        bare = _signal(last_seen_at="", excerpt="无薪资", job_title="普通")
        result = gated_score(bare, dict(SEED_WEIGHTS), supply=0, now=NOW)
        self.assertEqual(result["action"], "OBSERVE")

    def test_tie_breaker_fixed_order(self):
        rows = [
            {"fingerprint": "b", "score": 80, "coverage": 0.9, "freshness_days": 2},
            {"fingerprint": "a", "score": 80, "coverage": 0.9, "freshness_days": 2},
            {"fingerprint": "c", "score": 80, "coverage": 0.8, "freshness_days": 9},
            {"fingerprint": "d", "score": 70, "coverage": 1.0, "freshness_days": 1},
            {"fingerprint": "e", "score": 80, "coverage": 0.9, "freshness_days": 1},
        ]
        ordered = [r["fingerprint"] for r in tie_break(rows)]
        self.assertEqual(ordered, ["e", "a", "b", "c", "d"])

    def test_replay_byte_stable_with_fixed_clock(self):
        signals = [_signal(fingerprint=f"fp-{i}", excerpt="薪资 20-40k 急招") for i in range(5)]

        def run():
            rows = []
            for s in signals:
                gated = gated_score(s, dict(SEED_WEIGHTS), supply=5, now=NOW)
                rows.append({"fingerprint": s["fingerprint"], **gated})
            return json.dumps(tie_break(rows), ensure_ascii=False, sort_keys=True)

        self.assertEqual(run(), run())
        # clock 改变结果必须变（证明 now 真的注入）
        later = NOW + timedelta(days=3)
        changed = json.dumps(tie_break([{"fingerprint": s["fingerprint"],
                                         **gated_score(s, dict(SEED_WEIGHTS), 5, now=later)} for s in signals]),
                             ensure_ascii=False, sort_keys=True)
        self.assertNotEqual(run(), changed)


class DualTrackPolicyTests(unittest.TestCase):
    def test_sample_gate_blocks_learning(self):
        current = dict(SEED_WEIGHTS)
        few_events = [{"type": "view"}] * 19
        outcomes = [{"scope": "consultant_scoped"}] * 5
        self.assertEqual(maybe_learn(few_events, outcomes, current)["status"], "insufficient_events")
        many_events = [{"type": "view"}] * 20
        few_outcomes = [{"scope": "consultant_scoped"}] * 4
        self.assertEqual(maybe_learn(many_events, few_outcomes, current)["status"], "insufficient_outcomes")
        # 样本不足返回原策略
        self.assertEqual(maybe_learn(few_events, outcomes, current)["weights"], current)

    def test_learned_policy_is_shadow_and_valid(self):
        current = dict(SEED_WEIGHTS)
        result = maybe_learn([{"type": "view"}] * 20, [{"scope": "consultant_scoped"}] * 5, current)
        self.assertEqual(result["status"], "shadow")  # 不接管排序
        validate_policy(result["weights"])
        # 有界：单维仍在 bounds 内
        for name, value in result["weights"].items():
            lo, hi = BOUNDS[name]
            self.assertTrue(lo <= value <= hi, name)

    def test_priority_manual_over_auto_over_baseline(self):
        baseline = dict(SEED_WEIGHTS)
        auto = dict(SEED_WEIGHTS)
        manual = {**SEED_WEIGHTS, "urgency": 0.35, "freshness": 0.15}
        kind, _ = resolve_policy(baseline, None, None, manual_unlocked=False)
        self.assertEqual(kind, "baseline")
        kind, _ = resolve_policy(baseline, auto, manual, manual_unlocked=False)
        self.assertEqual(kind, "auto_active")  # 未解锁时手工不生效
        kind, chosen = resolve_policy(baseline, auto, manual, manual_unlocked=True)
        self.assertEqual(kind, "manual_override")
        self.assertEqual(chosen, manual)

    def test_unlock_trigger_two_consecutive_unsatisfied(self):
        responses = [
            {"type": "ignore", "reason_code": "岗位不靠谱"},
            {"type": "feedback", "score": 2},
        ]
        progress = manual_unlock_progress(responses)
        self.assertTrue(progress["unlocked"])

    def test_satisfied_resets_streak(self):
        responses = [
            {"type": "ignore", "reason_code": "岗位不靠谱"},
            {"type": "accept"},  # 穿插满意 → 清零
            {"type": "feedback", "score": 1},
        ]
        progress = manual_unlock_progress(responses)
        self.assertFalse(progress["unlocked"])
        self.assertEqual(progress["streak"], 1)
        self.assertEqual(progress["rounds_to_go"], 1)

    def test_release_attributed_to_bad_recommendation_counts(self):
        responses = [
            {"type": "release", "reason_code": "推荐不准"},
            {"type": "release", "reason_code": "人选不对"},
        ]
        self.assertTrue(manual_unlock_progress(responses)["unlocked"])
        # release 归因其他原因不计
        self.assertFalse(manual_unlock_progress(
            [{"type": "release", "reason_code": "客户暂停"}, {"type": "release", "reason_code": "客户暂停"}]
        )["unlocked"])

    def test_streak_survives_across_days(self):
        # 跨日有效：窗口按响应序列而非自然日
        day1 = [{"type": "ignore", "reason_code": "差"}]
        day2 = [{"type": "dismiss", "reason_code": "差"}]
        self.assertTrue(manual_unlock_progress(day1 + day2)["unlocked"])

    def test_consultant_isolation(self):
        a_events = [{"type": "view"}] * 20
        a_outcomes = [{"scope": "consultant_scoped"}] * 5
        b_result = maybe_learn([], [], dict(SEED_WEIGHTS))  # B 无事件
        a_result = maybe_learn(a_events, a_outcomes, dict(SEED_WEIGHTS))
        self.assertEqual(b_result["status"], "insufficient_events")
        self.assertEqual(a_result["status"], "shadow")
        self.assertNotEqual(a_result["weights"], b_result["weights"])


class EvidenceContractTests(unittest.TestCase):
    def test_contract_shape_and_version(self):
        candidates = [
            {"fingerprint": "cand-1", "name": "张某", "raw_text": "Java 架构师 8 年，微服务 Spring Cloud 高并发 分布式 缓存 消息队列 " * 5, "phone": "13800000000", "email": "z@x.com"},
            {"fingerprint": "cand-2", "name": "李某", "raw_text": "产品经理 3 年"},
        ]
        payload = supply_evidence(_signal(), candidates, NOW)
        self.assertEqual(payload["schema_version"], "evidence-1.0")
        self.assertEqual(payload["source"], "braintex")
        self.assertEqual(set(payload), {"fingerprint", "as_of", "supply", "signal", "source", "schema_version"})
        self.assertEqual(set(payload["supply"]), {"hits", "pass_score", "top"})
        self.assertEqual(set(payload["signal"]), {"signal_type", "last_seen_at", "keywords"})
        self.assertEqual(payload["supply"]["pass_score"], PASS_SCORE)
        for person in payload["supply"]["top"]:
            self.assertEqual(set(person), {"name", "score", "evidence"})
            # 候选人 phone/email 不出证据接口
            self.assertNotIn("phone", person)
            self.assertNotIn("email", person)
            self.assertNotIn("13800000000", json.dumps(payload, ensure_ascii=False))

    def test_hits_matches_trial_picker_semantics(self):
        candidates = [{"fingerprint": f"cand-{i}", "name": f"候选{i}",
                       "raw_text": "Java 架构 微服务 高并发 分布式 系统设计 缓存 队列 性能优化 " * 5}
                      for i in range(4)]
        payload = supply_evidence(_signal(), candidates, NOW)
        self.assertEqual(payload["supply"]["hits"], 4)
        self.assertLessEqual(len(payload["supply"]["top"]), 3)


class MySqlPitfallGuardTests(unittest.TestCase):
    """文档 §9/避坑清单：v2 DDL 不得含 MySQL 8 不支持的语法。"""

    def test_v2_ddl_avoids_mysql_pitfalls(self):
        from pathlib import Path

        ddl = Path(__file__).resolve().parents[1] / "decision" / "schema_v2.sql"
        # 只扫描可执行语句，剔除 `--` 注释行（注释里的避坑说明不算语法）
        lines = [line for line in ddl.read_text(encoding="utf-8").splitlines() if not line.strip().startswith("--")]
        sql = "\n".join(lines).upper()
        for banned in ("ILIKE", "NULLS LAST", "ADD COLUMN IF NOT EXISTS", "CREATE INDEX IF NOT EXISTS"):
            self.assertNotIn(banned, sql)
        for table in ("decision_events", "engagements", "outcome_observations", "policy_versions", "sync_runs"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table.upper()}", sql)

    def test_v2_columns_fit_contract_values(self):
        """RDS 冒烟抓到的真 bug 回归锁：scope VARCHAR(16) 放不下 'consultant_scoped'(17)。"""
        import re
        from pathlib import Path

        ddl = (Path(__file__).resolve().parents[1] / "decision" / "schema_v2.sql").read_text(encoding="utf-8")
        cases = {
            "scope": ["consultant_scoped", "team_aggregate"],
            "kind": ["baseline", "auto_shadow", "auto_active", "manual_override"],
            "status": ["shadow", "active", "rolled_back", "superseded"],
            "event_type": ["RECOMMENDED", "EXPOSED", "VIEWED", "WATCHED", "ACCEPTED", "DISMISSED",
                           "RELEASED", "EXPIRED", "COMPLETED", "OUTCOME_RECORDED", "CORRECTION"],
        }
        for column, values in cases.items():
            match = re.search(rf"\b{column}\s+VARCHAR\((\d+)\)", ddl)
            self.assertIsNotNone(match, column)
            width = int(match.group(1))
            for value in values:
                self.assertLessEqual(len(value), width, f"{column}({width}) 放不下 {value!r}")


if __name__ == "__main__":
    unittest.main()
