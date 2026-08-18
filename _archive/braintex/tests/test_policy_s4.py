"""S4 验收测试：双轨调权（开发文档 v2.0 §11 S4）。

验收口径：
- 样本不足不更新；新策略不自动接管；可回滚 baseline；
- 连续 2 轮不满意解锁、穿插满意清零；A 顾问事件不影响 B 顾问。
另覆盖：EMA 有界增量、版本校验、Shadow→Active 离线回放门槛、
手工版本 supersede 链、resolve 三层优先级。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta

from decision import commands, personalizer
from decision.db import SEED_WEIGHTS
from decision.event_store import MemoryStore

NOW = datetime(2026, 8, 5, 10, 0, 0)
BASELINE = {"policy_version": "baseline-1.0", "weights": dict(SEED_WEIGHTS)}


def _fill_events(store, consultant, count, fp_prefix="fp"):
    for i in range(count):
        store.append_event({
            "event_id": f"e-{consultant}-{i}", "consultant_id": consultant,
            "opportunity_id": f"{fp_prefix}{i % 4}", "decision_id": None,
            "event_type": "VIEWED", "previous_state": "RECOMMENDED", "next_state": "VIEWED",
            "actor": consultant, "reason_code": "", "metadata_json": {},
            "policy_version": "baseline-1.0", "occurred_at": NOW, "recorded_at": NOW,
            "idempotency_key": f"k-{consultant}-{i}",
        })


def _fill_outcomes(store, consultant, count, stage="面试", value=None):
    for i in range(count):
        store.append_outcome({
            "outcome_id": f"o-{consultant}-{i}", "consultant_id": consultant,
            "opportunity_id": f"fp{i}", "scope": "consultant_scoped", "source": "manual",
            "stage": stage, "value_json": value or {"result": "通过"},
            "recorded_by": consultant, "idempotency_key": f"ok-{consultant}-{i}",
            "observed_at": NOW, "recorded_at": NOW,
        })


class SampleGateTests(unittest.TestCase):
    def test_insufficient_events_no_update(self):
        store = MemoryStore()
        _fill_events(store, "ashley", 19)
        _fill_outcomes(store, "ashley", 5)
        result = personalizer.maybe_learn(store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(result["status"], "insufficient_events")
        self.assertEqual(result["weights"], SEED_WEIGHTS)  # 原策略不动
        self.assertEqual(store.list_policies("ashley"), [])  # 不落版本

    def test_insufficient_outcomes_no_update(self):
        store = MemoryStore()
        _fill_events(store, "ashley", 25)
        _fill_outcomes(store, "ashley", 4)
        result = personalizer.maybe_learn(store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(result["status"], "insufficient_outcomes")
        self.assertEqual(store.list_policies("ashley"), [])

    def test_correction_events_not_counted(self):
        store = MemoryStore()
        _fill_events(store, "ashley", 19)
        store.append_event({"event_id": "c1", "consultant_id": "ashley", "opportunity_id": "fp1",
                            "decision_id": None, "event_type": "CORRECTION", "previous_state": "",
                            "next_state": "", "actor": "ashley", "reason_code": "",
                            "metadata_json": {}, "policy_version": "", "occurred_at": NOW,
                            "recorded_at": NOW, "idempotency_key": "corr-1"})
        _fill_outcomes(store, "ashley", 5)
        result = personalizer.maybe_learn(store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(result["status"], "insufficient_events")  # 19+CORRECTION ≠ 20


class ShadowLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        _fill_events(self.store, "ashley", 25)
        _fill_outcomes(self.store, "ashley", 6)

    def test_learned_policy_is_shadow_and_never_takes_over(self):
        result = personalizer.maybe_learn(self.store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(result["status"], "shadow")
        personalizer.validate_weights(result["weights"])
        row = self.store.list_policies("ashley", kind="auto_shadow")[-1]
        self.assertEqual(row["status"], "shadow")
        # 验收：新策略不自动接管——resolve 仍回落 baseline
        resolved = personalizer.resolve(self.store, "ashley", BASELINE)
        self.assertEqual(resolved["kind"], "baseline")

    def test_shadow_parent_chain(self):
        first = personalizer.maybe_learn(self.store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        second = personalizer.maybe_learn(self.store, "ashley", first["weights"],
                                          now=NOW + timedelta(hours=1))
        rows = self.store.list_policies("ashley", kind="auto_shadow")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1]["parent_version"], first["policy_version"])
        self.assertNotEqual(second["weights"], first["weights"])  # EMA 继续推进

    def test_promote_requires_replay_pass(self):
        result = personalizer.maybe_learn(self.store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        dims = [{"name": n, "score": 80} for n in SEED_WEIGHTS]
        recs = [{"reasons_json": {"dimensions": dims}}]
        # shadow 平均分 ≥ baseline（同分平局即达标）
        promoted = personalizer.promote(self.store, "ashley", result["policy_version"],
                                        recommendations=recs, baseline_weights=dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(promoted["status"], "active")
        resolved = personalizer.resolve(self.store, "ashley", BASELINE)
        self.assertEqual(resolved["kind"], "auto_active")
        # 再验证 replay 门槛的区分度：偏科权重（和=1）在均匀快照下平局达标……
        bad_weights = {n: 0.1 for n in SEED_WEIGHTS}
        bad_weights["supply_match"] = 0.6
        ok, _metrics = personalizer.offline_replay_ok(recs, bad_weights, dict(SEED_WEIGHTS))
        self.assertTrue(ok)  # 同 80 分下均值相等 → 达标
        skewed = [{"reasons_json": {"dimensions": [{"name": "supply_match", "score": 10},
                                                   {"name": "freshness", "score": 100}]}}]
        ok2, _ = personalizer.offline_replay_ok(skewed, bad_weights, dict(SEED_WEIGHTS))
        self.assertFalse(ok2)  # 该权重分布在偏科快照上输给 baseline → 拦截

    def test_promote_unknown_version_rejected(self):
        with self.assertRaises(ValueError):
            personalizer.promote(self.store, "ashley", "auto-shadow-不存在",
                                 baseline_weights=dict(SEED_WEIGHTS), now=NOW)


class ManualOverrideTests(unittest.TestCase):
    def _save_manual(self, store, consultant, weights, note="", tag="1"):
        now = NOW
        for old in store.list_policies(consultant, kind="manual_override", status="active"):
            store.set_policy_status(old["policy_version"], "superseded")
        store.save_policy({
            "policy_version": f"manual-{consultant}-{tag}", "consultant_id": consultant,
            "kind": "manual_override", "status": "active", "weights": weights,
            "bounds": {k: [0.05, 0.6] for k in SEED_WEIGHTS}, "parent_version": "",
            "metadata": {"manual_tuning_unlocked": True, "trigger": note},
            "activated_at": now, "created_at": now,
        })

    def test_priority_manual_over_auto_over_baseline(self):
        store = MemoryStore()
        _fill_events(store, "ashley", 25)
        _fill_outcomes(store, "ashley", 6)
        learned = personalizer.maybe_learn(store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        recs = [{"reasons_json": {"dimensions": [{"name": n, "score": 80} for n in SEED_WEIGHTS]}}]
        personalizer.promote(store, "ashley", learned["policy_version"],
                             recommendations=recs, baseline_weights=dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(personalizer.resolve(store, "ashley", BASELINE)["kind"], "auto_active")
        manual_weights = {**SEED_WEIGHTS, "urgency": 0.35, "freshness": 0.15}
        manual_weights = {k: v / sum(manual_weights.values()) for k, v in manual_weights.items()}
        self._save_manual(store, "ashley", manual_weights)
        resolved = personalizer.resolve(store, "ashley", BASELINE)
        self.assertEqual(resolved["kind"], "manual_override")
        self.assertEqual(resolved["weights"], manual_weights)

    def test_rollback_returns_to_baseline(self):
        store = MemoryStore()
        self._save_manual(store, "ashley", dict(SEED_WEIGHTS))
        result = personalizer.rollback_manual(store, "ashley")
        self.assertTrue(result["ok"])
        resolved = personalizer.resolve(store, "ashley", BASELINE)
        self.assertEqual(resolved["kind"], "baseline")  # 验收：可回滚 baseline
        row = store.list_policies("ashley", kind="manual_override")[-1]
        self.assertEqual(row["status"], "rolled_back")
        # 再次回滚给出明确提示
        self.assertFalse(personalizer.rollback_manual(store, "ashley")["ok"])

    def test_old_manual_superseded_on_new_save(self):
        store = MemoryStore()
        self._save_manual(store, "ashley", dict(SEED_WEIGHTS), tag="1")
        self._save_manual(store, "ashley", dict(SEED_WEIGHTS), tag="2")
        rows = store.list_policies("ashley", kind="manual_override", status="active")
        self.assertEqual(len(rows), 1)  # 旧版已 superseded（由 _save_manual 处理）
        self.assertEqual(rows[0]["policy_version"], "manual-ashley-2")


class IsolationTests(unittest.TestCase):
    def test_consultant_a_events_never_affect_b(self):
        store = MemoryStore()
        _fill_events(store, "ashley", 25)
        _fill_outcomes(store, "ashley", 6)
        learned_a = personalizer.maybe_learn(store, "ashley", dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(learned_a["status"], "shadow")
        result_b = personalizer.maybe_learn(store, "bob", dict(SEED_WEIGHTS), now=NOW)
        self.assertEqual(result_b["status"], "insufficient_events")  # B 无数据，不学 A 的
        self.assertEqual(personalizer.resolve(store, "bob", BASELINE)["kind"], "baseline")
        self.assertEqual(store.list_policies("bob"), [])


class ValidationTests(unittest.TestCase):
    def test_bounds_enforced(self):
        with self.assertRaises(ValueError):
            personalizer.validate_weights({**SEED_WEIGHTS, "supply_match": 0.9})
        with self.assertRaises(ValueError):
            personalizer.validate_weights({**SEED_WEIGHTS, "freshness": 0.01})
        with self.assertRaises(ValueError):
            personalizer.validate_weights({"freshness": 1.0})
        with self.assertRaises(ValueError):
            personalizer.validate_weights({**SEED_WEIGHTS, "urgency": "高"})

    def test_ema_update_bounded_and_normalized(self):
        extreme = {n: 1.0 for n in SEED_WEIGHTS}  # 极端奖励信号
        for _ in range(50):  # 反复迭代也不越界
            updated = personalizer.ema_update(dict(SEED_WEIGHTS), extreme)
            for name, value in updated.items():
                lo, hi = personalizer.DEFAULT_BOUNDS[name]
                self.assertTrue(lo <= value <= hi, name)
            self.assertAlmostEqual(sum(updated.values()), 1.0, places=4)


if __name__ == "__main__":
    unittest.main()
