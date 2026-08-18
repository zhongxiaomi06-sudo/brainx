"""S6 验收测试：braintex MCP server——agent 群体调用插件 + 强制鉴权。

验收口径（2026-08-05 用户指令）：
- 强制鉴权必须强制规定：启动 fail-closed（无 TTC_DECISION_MCP_TOKEN 拒绝服务）；
  **每个工具调用（含只读）**缺/错 token 一律拒绝；缺 actor 一律拒绝。
- 操作逻辑与 app 完全一致：写工具与 HTTP 端点共用 commands/personalizer/policy
  同一套领域函数（补链、幂等、关注位上限、CORRECTION、两轮不满意解锁门禁）。
- agent 阅读逻辑：承接列表/错误响应附 legal_commands，自然语言可链式操作。
- 数据不脱敏：evidence/信号原文透出（phone/email 不打码）。
"""

from __future__ import annotations

import os
import unittest
from datetime import datetime
from unittest import mock

import pytest

pytest.importorskip("mcp.server.fastmcp")  # 系统 python 无 mcp 包时整文件跳过（用 venv 跑）

TOKEN = "test-mcp-token"

import decision.mcp_server as mcp_server
from decision import commands as decision_commands
from decision import personalizer
from decision.event_store import MemoryStore
from decision.db import SEED_WEIGHTS

ACTOR = "ashley"
NOW = datetime(2026, 8, 5, 10, 0, 0)


def _weights():
    return {"freshness": 0.3, "salary_fit": 0.2, "urgency": 0.2,
            "supply_match": 0.2, "client_history": 0.1}


class McpTestBase(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {
            "TTC_DECISION_MCP_TOKEN": TOKEN,
            "TTC_DECISION_MCP_STORE": "memory",
        })
        self._env.start()
        mcp_server._MEMORY_STORE = MemoryStore()
        self.store = mcp_server._MEMORY_STORE

    def tearDown(self):
        self._env.stop()
        mcp_server._MEMORY_STORE = None

    def _seed_recommend(self, fp, actor=ACTOR):
        """系统日推落账（不走工具层——系统命令本就不对 agent 开放）。"""
        return decision_commands.execute_command(
            self.store, "recommend", consultant_id=actor, opportunity_id=fp,
            idempotency_key=f"rec:{actor}:{fp}", now=NOW)


class AuthEnforcementTests(McpTestBase):
    """强制鉴权：所有工具（读+写）缺/错 token、缺 actor 一律拒绝。"""

    READ_CALLS = [
        lambda a, t: mcp_server.decision_today(token=t, actor=a),
        lambda a, t: mcp_server.decision_engagements(token=t, actor=a),
        lambda a, t: mcp_server.decision_timeline(token=t, actor=a, fingerprint="fp1"),
        lambda a, t: mcp_server.decision_outcomes(token=t, actor=a),
        lambda a, t: mcp_server.decision_policy(token=t, actor=a),
        lambda a, t: mcp_server.decision_evidence_supply(token=t, actor=a, fingerprint="fp1"),
        lambda a, t: mcp_server.decision_job_signals(token=t, actor=a),
        lambda a, t: mcp_server.decision_replay_check(token=t, actor=a),
    ]
    WRITE_CALLS = [
        lambda a, t: mcp_server.decision_command(token=t, actor=a, command="watch", fingerprint="fp1"),
        lambda a, t: mcp_server.decision_record_outcome(token=t, actor=a, fingerprint="fp1",
                                                        stage="反馈", value={"rating": 3}),
        lambda a, t: mcp_server.decision_save_weights(token=t, actor=a, weights=_weights()),
        lambda a, t: mcp_server.decision_rollback(token=t, actor=a),
    ]

    def test_startup_fails_closed_without_token(self):
        with mock.patch.dict(os.environ, {"TTC_DECISION_MCP_TOKEN": ""}):
            with self.assertRaises(SystemExit) as ctx:
                mcp_server.main()
        self.assertEqual(ctx.exception.code, 2)

    def test_server_not_configured_blocks_tool_calls(self):
        with mock.patch.dict(os.environ, {"TTC_DECISION_MCP_TOKEN": ""}):
            result = mcp_server.decision_engagements(token=TOKEN, actor=ACTOR)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "server_not_configured")

    def test_all_read_tools_reject_wrong_token(self):
        for call in self.READ_CALLS:
            result = call(ACTOR, "wrong-token")
            self.assertFalse(result["ok"], call)
            self.assertEqual(result["code"], "auth_failed", call)

    def test_all_write_tools_reject_wrong_token_and_have_no_side_effects(self):
        self._seed_recommend("fp1")
        for call in self.WRITE_CALLS:
            result = call(ACTOR, "wrong-token")
            self.assertFalse(result["ok"], call)
            self.assertEqual(result["code"], "auth_failed", call)
        # 无任何副作用：事件/结果/策略保持只有种子数据
        self.assertEqual(len(self.store.events), 1)
        self.assertEqual(self.store.outcomes, [])
        self.assertEqual(self.store.policies, [])
        self.assertEqual(self.store.get_engagement(ACTOR, "fp1")["state"], "RECOMMENDED")

    def test_missing_token_rejected(self):
        for call in self.READ_CALLS + self.WRITE_CALLS:
            result = call(ACTOR, "")
            self.assertEqual(result["code"], "missing_token", call)

    def test_missing_actor_rejected(self):
        for call in self.READ_CALLS + self.WRITE_CALLS:
            result = call("", TOKEN)
            self.assertEqual(result["code"], "missing_actor", call)

    def test_correct_credentials_pass(self):
        with mock.patch.object(mcp_server, "_fetch_today", return_value=[]), \
             mock.patch.object(mcp_server, "_fetch_signal", return_value=None), \
             mock.patch.object(mcp_server, "_fetch_job_signals", return_value=[]), \
             mock.patch.object(mcp_server.db, "current_weights",
                               return_value={"version": 1, "weights": dict(SEED_WEIGHTS)}):
            for call in self.READ_CALLS:
                result = call(ACTOR, TOKEN)
                self.assertNotEqual(result.get("code"), "auth_failed", call)


class CommandLogicTests(McpTestBase):
    """操作逻辑与 HTTP app 一致：同一套 commands 领域函数。"""

    def test_command_watch_chain_and_idempotency(self):
        self._seed_recommend("fp1")
        result = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch",
                                             fingerprint="fp1", idempotency_key="k1")
        self.assertTrue(result["ok"])
        self.assertEqual(result["state"], "WATCHED")
        self.assertIn("accept", result["legal_commands"])
        # 补链：VIEWED + WATCHED 两个事件
        types = [e["event_type"] for e in self.store.events]
        self.assertEqual(types, ["RECOMMENDED", "VIEWED", "WATCHED"])
        # 幂等：同键重复不产生新事件
        again = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch",
                                            fingerprint="fp1", idempotency_key="k1")
        self.assertTrue(again["ok"])
        self.assertTrue(again["already"])
        self.assertEqual(len(self.store.events), 3)

    def test_illegal_command_returns_state_and_legal_hints(self):
        self._seed_recommend("fp1")
        result = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="complete",
                                             fingerprint="fp1")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "illegal_command")
        self.assertEqual(result["state"], "RECOMMENDED")
        self.assertEqual(result["legal_commands"], ["watch", "accept", "dismiss"])
        self.assertEqual(len(self.store.events), 1)  # 无落账

    def test_system_commands_forbidden_for_agents(self):
        for cmd in ("recommend", "expire", "view"):
            result = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command=cmd,
                                                 fingerprint="fp1")
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "system_command_forbidden")
        self.assertEqual(self.store.events, [])

    def test_dismiss_requires_reason(self):
        self._seed_recommend("fp1")
        result = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="dismiss",
                                             fingerprint="fp1")
        self.assertFalse(result["ok"])
        self.assertIn("reason_code", result["error"])

    def test_watch_cap_enforced(self):
        with mock.patch.dict(os.environ, {"TTC_DECISION_WATCH_CAP": "1"}):
            self._seed_recommend("fp1")
            self._seed_recommend("fp2")
            first = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch",
                                                fingerprint="fp1")
            self.assertTrue(first["ok"])
            second = mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch",
                                                 fingerprint="fp2")
            self.assertFalse(second["ok"])
            self.assertIn("关注位已满", second["error"])

    def test_consultant_isolation(self):
        """actor 即 consultant：A 的承接对 B 不可见（隔离由 actor 天然保证）。"""
        self._seed_recommend("fp1")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch", fingerprint="fp1")
        other = mcp_server.decision_engagements(token=TOKEN, actor="bob")
        self.assertEqual(other["count"], 0)
        mine = mcp_server.decision_engagements(token=TOKEN, actor=ACTOR)
        self.assertEqual(mine["count"], 1)


class OutcomeFeedbackTests(McpTestBase):
    def test_outcome_correction_never_mutates_history(self):
        self._seed_recommend("fp1")
        first = mcp_server.decision_record_outcome(
            token=TOKEN, actor=ACTOR, fingerprint="fp1", stage="反馈",
            value={"rating": 4}, idempotency_key="o1")
        self.assertTrue(first["ok"])
        self.assertFalse(first["correction"])
        second = mcp_server.decision_record_outcome(
            token=TOKEN, actor=ACTOR, fingerprint="fp1", stage="反馈",
            value={"rating": 5}, idempotency_key="o2")
        self.assertTrue(second["ok"])
        self.assertTrue(second["correction"])
        types = [e["event_type"] for e in self.store.events]
        self.assertIn("CORRECTION", types)
        self.assertEqual(types.count("OUTCOME_RECORDED"), 2)  # 历史不改，只追加

    def test_outcome_idempotent(self):
        self._seed_recommend("fp1")
        mcp_server.decision_record_outcome(token=TOKEN, actor=ACTOR, fingerprint="fp1",
                                           stage="面试", value={"pass": True},
                                           idempotency_key="o1")
        again = mcp_server.decision_record_outcome(token=TOKEN, actor=ACTOR, fingerprint="fp1",
                                                   stage="面试", value={"pass": True},
                                                   idempotency_key="o1")
        self.assertTrue(again["already"])
        self.assertEqual(len(self.store.outcomes), 1)


class WeightsGateTests(McpTestBase):
    """手工调权门禁：两轮不满意解锁，穿插满意清零——与 HTTP 同一门禁。"""

    def _two_unsatisfied(self):
        for fp in ("fp1", "fp2"):
            self._seed_recommend(fp)
            result = mcp_server.decision_command(
                token=TOKEN, actor=ACTOR, command="dismiss", fingerprint=fp,
                reason_code="人选不对", idempotency_key=f"d:{fp}")
            self.assertTrue(result["ok"])

    def test_locked_by_default(self):
        result = mcp_server.decision_save_weights(token=TOKEN, actor=ACTOR, weights=_weights())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "locked")
        self.assertEqual(result["rounds_to_go"], 2)
        self.assertEqual(self.store.policies, [])

    def test_unlock_after_two_unsatisfied_then_save_and_rollback(self):
        self._two_unsatisfied()
        saved = mcp_server.decision_save_weights(token=TOKEN, actor=ACTOR,
                                                 weights=_weights(), note="agent 调权")
        self.assertTrue(saved["ok"])
        self.assertEqual(saved["kind"], "manual_override")
        self.assertFalse(saved["normalized"])
        # 生效策略被手工版本接管
        baseline = {"kind": "baseline", "policy_version": "baseline-1.0",
                    "weights": dict(SEED_WEIGHTS)}
        resolved = personalizer.resolve(self.store, ACTOR, baseline)
        self.assertEqual(resolved["kind"], "manual_override")
        self.assertEqual(resolved["weights"]["freshness"], 0.3)
        # 回滚后回落 baseline
        rolled = mcp_server.decision_rollback(token=TOKEN, actor=ACTOR)
        self.assertTrue(rolled["ok"])
        resolved = personalizer.resolve(self.store, ACTOR, baseline)
        self.assertEqual(resolved["kind"], "baseline")

    def test_satisfied_resets_streak(self):
        self._seed_recommend("fp1")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="dismiss",
                                    fingerprint="fp1", reason_code="人选不对")
        self._seed_recommend("fp2")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="accept",
                                    fingerprint="fp2")  # 满意 → 清零
        result = mcp_server.decision_save_weights(token=TOKEN, actor=ACTOR, weights=_weights())
        self.assertEqual(result["code"], "locked")
        self.assertEqual(result["rounds_to_go"], 2)

    def test_invalid_weights_rejected_even_when_unlocked(self):
        self._two_unsatisfied()
        bad = mcp_server.decision_save_weights(token=TOKEN, actor=ACTOR,
                                               weights={"freshness": 0.9})
        self.assertEqual(bad["code"], "dimension_mismatch")


class ReadToolTests(McpTestBase):
    def test_engagements_legal_commands_per_state(self):
        self._seed_recommend("fp1")
        self._seed_recommend("fp2")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="accept", fingerprint="fp2")
        result = mcp_server.decision_engagements(token=TOKEN, actor=ACTOR)
        by_fp = {i["fingerprint"]: i for i in result["items"]}
        self.assertEqual(by_fp["fp1"]["legal_commands"], ["watch", "accept", "dismiss"])
        self.assertEqual(by_fp["fp2"]["legal_commands"], ["release", "complete"])
        self.assertEqual(result["state_counts"], {"RECOMMENDED": 1, "ACCEPTED": 1})

    def test_engagements_state_filter(self):
        self._seed_recommend("fp1")
        self._seed_recommend("fp2")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="accept", fingerprint="fp2")
        result = mcp_server.decision_engagements(token=TOKEN, actor=ACTOR, state="ACCEPTED")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["items"][0]["fingerprint"], "fp2")

    def test_timeline_events_and_outcomes(self):
        self._seed_recommend("fp1")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch", fingerprint="fp1")
        mcp_server.decision_record_outcome(token=TOKEN, actor=ACTOR, fingerprint="fp1",
                                           stage="面试", value={"pass": True})
        timeline = mcp_server.decision_timeline(token=TOKEN, actor=ACTOR, fingerprint="fp1")
        self.assertEqual(timeline["state"], "WATCHED")
        self.assertEqual([e["event_type"] for e in timeline["events"]][:3],
                         ["RECOMMENDED", "VIEWED", "WATCHED"])
        self.assertEqual(timeline["outcomes"][0]["stage"], "面试")

    def test_outcomes_list(self):
        self._seed_recommend("fp1")
        mcp_server.decision_record_outcome(token=TOKEN, actor=ACTOR, fingerprint="fp1",
                                           stage="反馈", value={"rating": 5})
        result = mcp_server.decision_outcomes(token=TOKEN, actor=ACTOR)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["items"][0]["value"], {"rating": 5})

    def test_replay_check_consistent(self):
        self._seed_recommend("fp1")
        self._seed_recommend("fp2")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="watch", fingerprint="fp1")
        mcp_server.decision_command(token=TOKEN, actor=ACTOR, command="accept", fingerprint="fp2")
        result = mcp_server.decision_replay_check(token=TOKEN, actor=ACTOR)
        self.assertTrue(result["ok"])
        self.assertEqual(result["mismatches"], [])
        self.assertEqual(result["replayed"], 2)


class DataReadToolTests(McpTestBase):
    """读数据工具：生产 SQL 面整体替换，验证组装逻辑与不脱敏透出。"""

    def test_today_shape(self):
        rec = {
            "id": 7, "job_signal_fingerprint": "sig-1", "job_title": "Java 架构师",
            "company": "某大厂", "total_score": 78.5, "action": "RECOMMEND_WATCH",
            "confidence_band": "HIGH", "evidence_coverage": 0.9,
            "policy_version": "baseline-1.0",
            "reasons_json": '{"dimensions": [{"name": "freshness", "score": 8}]}',
            "trial_candidates_json": '[{"name": "王先生", "phone": "13522011639"}]',
        }
        with mock.patch.object(mcp_server, "_fetch_today", return_value=[rec]):
            result = mcp_server.decision_today(token=TOKEN, actor=ACTOR)
        self.assertTrue(result["ok"])
        item = result["items"][0]
        self.assertEqual(item["fingerprint"], "sig-1")
        self.assertEqual(item["dimensions"][0]["name"], "freshness")
        self.assertEqual(item["trial_candidates"][0]["phone"], "13522011639")  # 不脱敏

    def test_evidence_supply_unmasked(self):
        signal = {"fingerprint": "sig-1", "job_title": "Java 架构师",
                  "keywords": ["Java", "微服务"], "signal_type": "heating",
                  "last_seen_at": "2026-08-04 09:00:00",
                  "excerpt": "急招 13800001234"}
        candidate = {"fingerprint": "c1", "name": "王先生",
                     "raw_text": "Java 微服务 分布式 高并发 架构 缓存 队列 性能优化 " * 6,
                     "phone": "13522011639", "email": "20923089@qq.com"}
        with mock.patch.object(mcp_server, "_fetch_signal", return_value=signal), \
             mock.patch.object(mcp_server, "_fetch_supply_candidates", return_value=[candidate]):
            result = mcp_server.decision_evidence_supply(token=TOKEN, actor=ACTOR,
                                                         fingerprint="sig-1")
        self.assertEqual(result["schema_version"], "evidence-1.0")
        top = result["supply"]["top"][0]
        self.assertEqual(top["phone"], "13522011639")     # 原文透出
        self.assertEqual(top["email"], "20923089@qq.com")
        self.assertEqual(top["fingerprint"], "c1")        # 可直接接 command

    def test_evidence_supply_signal_not_found(self):
        with mock.patch.object(mcp_server, "_fetch_signal", return_value=None):
            result = mcp_server.decision_evidence_supply(token=TOKEN, actor=ACTOR,
                                                         fingerprint="nope")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "not_found")

    def test_job_signals_raw_excerpt(self):
        row = {"fingerprint": "s1", "job_title": "Agent 开发", "company": "物外智趣",
               "signal_type": "heating", "keywords": ["Agent"],
               "excerpt": "联系 hr@wuwai.com 或 13800001234",
               "last_seen_at": "2026-08-04 09:00:00"}
        with mock.patch.object(mcp_server, "_fetch_job_signals", return_value=[row]):
            result = mcp_server.decision_job_signals(token=TOKEN, actor=ACTOR,
                                                     signal_type="heating")
        self.assertEqual(result["count"], 1)
        excerpt = result["items"][0]["excerpt"]
        self.assertIn("13800001234", excerpt)   # 不打码
        self.assertIn("hr@wuwai.com", excerpt)


class PolicyToolTests(McpTestBase):
    def test_policy_read(self):
        with mock.patch.object(mcp_server.db, "current_weights",
                               return_value={"version": 1, "weights": dict(SEED_WEIGHTS)}):
            result = mcp_server.decision_policy(token=TOKEN, actor=ACTOR)
        self.assertTrue(result["ok"])
        self.assertEqual(result["effective"]["kind"], "baseline")
        self.assertFalse(result["manual_tuning"]["unlocked"])
        self.assertEqual(result["manual_tuning"]["rounds_to_go"], 2)


if __name__ == "__main__":
    unittest.main()
