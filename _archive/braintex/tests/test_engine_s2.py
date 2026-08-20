"""S2 验收测试：决策引擎升级（开发文档 v2.0 §11 S2）。

验收口径：
- 同一快照 + 同一策略版本，排序逐字节稳定（回放测试）；
- coverage < 0.5 强制 OBSERVE。
另覆盖：硬约束四类违规、0.5–0.7 封顶、confidence 只出三档、
tie-breaker 全序、clock 注入敏感性、sync 完整性阻断、policy_version 桥接。
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta

from decision.db import SEED_WEIGHTS
from decision.engine import (
    CONFIDENCE_BANDS, decide, hard_constraint_violation, score_with_coverage,
)
from decision.recommend import sync_block_reason

NOW = datetime(2026, 8, 5, 10, 0, 0)


def _signal(fp, **overrides):
    base = {
        "fingerprint": fp,
        "job_title": "急招 Java 架构师",
        "company": "某大厂",
        "excerpt": "薪资 30-50k，急聘，本周到岗",
        "signal_type": "heating",
        "last_seen_at": (NOW - timedelta(hours=6)).strftime("%Y-%m-%d %H:%M:%S"),
        "client_history": {"orders": 2},
    }
    base.update(overrides)
    return base


def _supply(hits=6, trial=None):
    return lambda signal: (hits, trial or [{"name": "张某", "score": 72.5, "evidence": ["ev"]}])


def _decide(signals, blocked=None):
    return decide(signals, dict(SEED_WEIGHTS), _supply(), now=NOW,
                  policy_version="baseline-1.0", blocked_fingerprints=blocked)


class HardConstraintTests(unittest.TestCase):
    def test_missing_job_title_excluded(self):
        violation = hard_constraint_violation(_signal("fp1", job_title=None), now=NOW, blocked_fingerprints=set())
        self.assertEqual(violation, "missing_key_fields")

    def test_inactive_signal_type_excluded(self):
        for bad in ("cooling", "closed", ""):
            violation = hard_constraint_violation(_signal("fp1", signal_type=bad), now=NOW, blocked_fingerprints=set())
            self.assertEqual(violation, "inactive_signal_type", bad)

    def test_stale_signal_excluded_by_injected_clock(self):
        old = (NOW - timedelta(days=8)).strftime("%Y-%m-%d %H:%M:%S")
        violation = hard_constraint_violation(_signal("fp1", last_seen_at=old), now=NOW, blocked_fingerprints=set())
        self.assertEqual(violation, "stale_signal")
        # 同一信号在 6 天前的时间坐标下合法——证明窗口由注入 clock 决定
        earlier_now = NOW - timedelta(days=2)
        self.assertEqual(hard_constraint_violation(_signal("fp1", last_seen_at=old), now=earlier_now,
                                                   blocked_fingerprints=set()), "")

    def test_blocked_fingerprint_excluded(self):
        violation = hard_constraint_violation(_signal("fp1"), now=NOW, blocked_fingerprints={"fp1"})
        self.assertEqual(violation, "engagement_state")

    def test_excluded_rows_not_in_recommendations(self):
        result = _decide([_signal("fp-ok"), _signal("fp-bad", job_title=""), _signal("fp-blocked")],
                         blocked={"fp-blocked"})
        self.assertEqual([r["fingerprint"] for r in result["rows"]], ["fp-ok"])
        reasons = {e["fingerprint"]: e["reason"] for e in result["excluded"]}
        self.assertEqual(reasons, {"fp-bad": "missing_key_fields", "fp-blocked": "engagement_state"})


class CoverageGatingTests(unittest.TestCase):
    def test_coverage_below_half_forces_observe(self):
        # 无时间、无薪资、无历史 → 可用 = urgency + supply_match = 0.45
        bare = _signal("fp1", last_seen_at="", excerpt="无薪资信息", job_title="普通岗位",
                       client_history=None)
        scored = score_with_coverage(bare, dict(SEED_WEIGHTS), 8, now=NOW)
        self.assertAlmostEqual(scored["evidence_coverage"], 0.45, places=2)
        self.assertEqual(scored["action"], "OBSERVE")
        self.assertEqual(scored["confidence_band"], "LOW")

    def test_mid_coverage_capped_at_watch(self):
        weights = {"freshness": 0.15, "salary_fit": 0.20, "urgency": 0.20,
                   "supply_match": 0.25, "client_history": 0.20}
        bare = _signal("fp1", excerpt="无薪资信息", client_history=None)
        scored = score_with_coverage(bare, weights, 8, now=NOW)
        self.assertAlmostEqual(scored["evidence_coverage"], 0.60, places=2)
        self.assertEqual(scored["action"], "RECOMMEND_WATCH")
        self.assertEqual(scored["confidence_band"], "LOW")

    def test_full_coverage_allows_accept_with_high_confidence(self):
        scored = score_with_coverage(_signal("fp1"), dict(SEED_WEIGHTS), 8, now=NOW)
        self.assertEqual(scored["evidence_coverage"], 1.0)
        self.assertEqual(scored["action"], "RECOMMEND_ACCEPT")
        self.assertEqual(scored["confidence_band"], "HIGH")

    def test_confidence_only_three_bands(self):
        for signal, hits in ((_signal("fp1"), 8),
                             (_signal("fp2", excerpt="无薪资", client_history=None), 8),
                             (_signal("fp3", last_seen_at="", excerpt="无薪资", client_history=None), 0)):
            scored = score_with_coverage(signal, dict(SEED_WEIGHTS), hits, now=NOW)
            self.assertIn(scored["confidence_band"], CONFIDENCE_BANDS)
            self.assertIn(scored["action"], ("RECOMMEND_ACCEPT", "RECOMMEND_WATCH", "OBSERVE"))


class ReplayStabilityTests(unittest.TestCase):
    def test_same_snapshot_same_policy_byte_identical(self):
        signals = [_signal(f"fp-{i}", excerpt="薪资 20-40k 急招") for i in range(6)]

        def run():
            return json.dumps(_decide(list(signals))["rows"], ensure_ascii=False, sort_keys=True, default=str)

        self.assertEqual(run(), run())

    def test_input_order_does_not_change_output(self):
        signals = [_signal(f"fp-{i}") for i in range(6)]
        forward = _decide(list(signals))["rows"]
        backward = _decide(list(reversed(signals)))["rows"]
        self.assertEqual(
            json.dumps(forward, sort_keys=True, default=str),
            json.dumps(backward, sort_keys=True, default=str),
        )

    def test_tie_breaker_total_order(self):
        # 构造同分同 coverage 的信号：只有 fingerprint 不同 → 必须按 fingerprint asc
        twins = [_signal("fp-bbb"), _signal("fp-aaa"), _signal("fp-ccc")]
        rows = _decide(twins)["rows"]
        keys = [(r["total_score"], r["evidence_coverage"]) for r in rows]
        self.assertEqual(len(set(keys)), 1)  # 确实同分
        self.assertEqual([r["fingerprint"] for r in rows], ["fp-aaa", "fp-bbb", "fp-ccc"])

    def test_clock_shift_changes_scores(self):
        signal = _signal("fp1")
        later = NOW + timedelta(days=3)
        now_out = score_with_coverage(signal, dict(SEED_WEIGHTS), 8, now=NOW)
        later_out = score_with_coverage(signal, dict(SEED_WEIGHTS), 8, now=later)
        self.assertNotEqual(now_out["total_score"], later_out["total_score"])

    def test_policy_version_propagates(self):
        rows = _decide([_signal("fp1")])["rows"]
        self.assertEqual(rows[0]["policy_version"], "baseline-1.0")


class SyncGuardTests(unittest.TestCase):
    def test_no_rows_allows_cold_start(self):
        self.assertEqual(sync_block_reason([]), "")

    def test_complete_run_allows(self):
        self.assertEqual(sync_block_reason([{"sync_id": "s1", "complete": 1}]), "")

    def test_incomplete_run_blocks(self):
        reason = sync_block_reason([{"sync_id": "s1", "complete": 0}])
        self.assertIn("阻断日推", reason)
        self.assertIn("s1", reason)


if __name__ == "__main__":
    unittest.main()
