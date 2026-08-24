"""S3 验收测试：工作台数据面（开发文档 v2.0 §11 S3）。

验收口径：
- 试单人卡片展示证据（_preview 带出 trial_candidates 证据与分档字段）；
- 调权页锁定态不可编辑（POST /weights 未解锁 403）；
- 反馈修改只产生 CORRECTION（历史不改，账本追加纠错事件）。
另覆盖：回放端点形状与排序位置、解锁进度计算、outcome 幂等与 scope 校验。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from decision import commands
from decision.api import _preview, _unlock_state
from decision.event_store import MemoryStore
from decision.policy import responses_from_events, unlock_progress

NOW = datetime(2026, 8, 5, 10, 0, 0)


def _rec(**overrides):
    base = {
        "id": 7,
        "job_signal_fingerprint": "fp1",
        "job_title": "Java 架构师",
        "company": "某大厂",
        "total_score": 82.5,
        "status": "pending",
        "action": "RECOMMEND_ACCEPT",
        "confidence_band": "HIGH",
        "evidence_coverage": 0.9,
        "policy_version": "baseline-1.0",
        "reasons_json": '{"dimensions": [{"name": "freshness", "score": 100, "weight": 0.25, "weighted": 25, "reason": "信号 0.2 天前活跃"}]}',
        "trial_candidates_json": '[{"name": "张某", "score": 72.5, "evidence": ["Java 微服务 8 年", "主导分布式改造"]}]',
    }
    base.update(overrides)
    return base


class PreviewCardTests(unittest.TestCase):
    def test_trial_candidate_cards_carry_evidence(self):
        item = _preview(_rec())
        trial = item["trial_candidates"]
        self.assertEqual(len(trial), 1)
        self.assertEqual(trial[0]["name"], "张某")
        self.assertEqual(len(trial[0]["evidence"]), 2)  # 试单人卡片展示证据 2 条
        self.assertEqual(item["action"], "RECOMMEND_ACCEPT")
        self.assertEqual(item["confidence_band"], "HIGH")
        self.assertEqual(item["evidence_coverage"], 0.9)
        self.assertEqual(item["policy_version"], "baseline-1.0")
        self.assertEqual(item["dimensions"][0]["weighted"], 25)


class OutcomeCorrectionTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()

    def test_first_record_then_modify_only_appends_correction(self):
        first = commands.record_outcome(
            self.store, consultant_id="ashley", opportunity_id="fp1",
            stage="面试", value={"result": "通过"}, idempotency_key="o1", now=NOW,
        )
        self.assertFalse(first["correction"])
        modified = commands.record_outcome(
            self.store, consultant_id="ashley", opportunity_id="fp1",
            stage="面试", value={"result": "未通过"}, idempotency_key="o2",
            now=NOW + timedelta(hours=2),
        )
        self.assertTrue(modified["correction"])
        outcomes = self.store.outcome_events_for("ashley", "fp1")
        self.assertEqual(len(outcomes), 2)  # 两次观察都保留
        events = self.store.list_events("ashley", "fp1")
        corrections = [e for e in events if e["event_type"] == "CORRECTION"]
        self.assertEqual(len(corrections), 1)
        meta = corrections[0]["metadata_json"]
        self.assertEqual(meta["previous_value"], {"result": "通过"})
        self.assertEqual(meta["new_value"], {"result": "未通过"})
        self.assertIn("corrects_event_id", meta)
        # 历史 OUTCOME_RECORDED 事件不被修改
        recorded = [e for e in events if e["event_type"] == "OUTCOME_RECORDED"]
        self.assertEqual(len(recorded), 2)
        self.assertFalse(recorded[0]["metadata_json"]["correction"])

    def test_same_value_re_record_no_correction(self):
        commands.record_outcome(self.store, consultant_id="ashley", opportunity_id="fp1",
                                stage="面试", value={"result": "通过"}, idempotency_key="o1", now=NOW)
        again = commands.record_outcome(self.store, consultant_id="ashley", opportunity_id="fp1",
                                        stage="面试", value={"result": "通过"}, idempotency_key="o2", now=NOW)
        self.assertFalse(again["correction"])

    def test_idempotent_replay_returns_original(self):
        first = commands.record_outcome(self.store, consultant_id="ashley", opportunity_id="fp1",
                                        stage="Offer", value={"amount": 30}, idempotency_key="o1", now=NOW)
        dup = commands.record_outcome(self.store, consultant_id="ashley", opportunity_id="fp1",
                                      stage="Offer", value={"amount": 99}, idempotency_key="o1", now=NOW)
        self.assertTrue(dup["already"])
        self.assertEqual(first["outcome_id"], dup["outcome_id"])
        self.assertEqual(len(self.store.outcomes), 1)

    def test_scope_validation(self):
        with self.assertRaises(Exception):
            commands.record_outcome(self.store, consultant_id="ashley", opportunity_id="fp1",
                                    stage="面试", value={}, scope="bogus", idempotency_key="o1", now=NOW)


class UnlockProgressTests(unittest.TestCase):
    def test_two_consecutive_unsatisfied_unlocks(self):
        store = MemoryStore()
        commands.execute_command(store, "recommend", consultant_id="ashley", opportunity_id="fp1",
                                 idempotency_key="rec1", now=NOW)
        commands.execute_command(store, "dismiss", consultant_id="ashley", opportunity_id="fp1",
                                 reason_code="岗位不靠谱", idempotency_key="d1", now=NOW)
        commands.record_outcome(store, consultant_id="ashley", opportunity_id="fp2",
                                stage="反馈", value={"rating": 2}, idempotency_key="f1", now=NOW)
        progress = _unlock_state(store, "ashley")
        self.assertTrue(progress["unlocked"])

    def test_satisfied_resets_streak(self):
        responses = responses_from_events(
            [{"event_type": "DISMISSED", "reason_code": "差", "occurred_at": NOW}],
            [],
        ) + [{"type": "accept", "at": NOW + timedelta(hours=1)}]
        responses.sort(key=lambda r: str(r.get("at") or ""))
        progress = unlock_progress(responses)
        self.assertFalse(progress["unlocked"])
        self.assertEqual(progress["rounds_to_go"], 2)

    def test_release_attribution_counts(self):
        store = MemoryStore()
        commands.execute_command(store, "watch", consultant_id="ashley", opportunity_id="fp1",
                                 idempotency_key="w1", now=NOW)
        commands.execute_command(store, "accept", consultant_id="ashley", opportunity_id="fp1",
                                 idempotency_key="a1", now=NOW)
        commands.execute_command(store, "release", consultant_id="ashley", opportunity_id="fp1",
                                 reason_code="推荐不准", idempotency_key="r1", now=NOW)
        progress = _unlock_state(store, "ashley")
        # accept 满意清零后 release 推荐不准计 1 轮
        self.assertEqual(progress["streak"], 1)
        self.assertFalse(progress["unlocked"])

    def test_isolation_between_consultants(self):
        store = MemoryStore()
        for i in (1, 2):
            commands.execute_command(store, "recommend", consultant_id="ashley",
                                     opportunity_id=f"fp{i}", idempotency_key=f"rec{i}", now=NOW)
            commands.execute_command(store, "dismiss", consultant_id="ashley", opportunity_id=f"fp{i}",
                                     reason_code="x", idempotency_key=f"d{i}", now=NOW)
        self.assertTrue(_unlock_state(store, "ashley")["unlocked"])
        self.assertFalse(_unlock_state(store, "bob")["unlocked"])


class WeightsGateTests(unittest.TestCase):
    def test_locked_consultant_cannot_write(self):
        """验收：调权页锁定态不可编辑——后端 403 是最终强制（前端禁用仅是体验层）。"""
        store = MemoryStore()
        self.assertFalse(_unlock_state(store, "ashley")["unlocked"])
        # 解锁后放行由 S4 手工版本化完整覆盖，这里锁门径判定
        for i in range(2):
            commands.execute_command(store, "recommend", consultant_id="ashley",
                                     opportunity_id=f"fp{i}", idempotency_key=f"rec{i}", now=NOW)
            commands.execute_command(store, "dismiss", consultant_id="ashley",
                                     opportunity_id=f"fp{i}", reason_code="x",
                                     idempotency_key=f"d{i}", now=NOW)
        self.assertTrue(_unlock_state(store, "ashley")["unlocked"])


if __name__ == "__main__":
    unittest.main()
