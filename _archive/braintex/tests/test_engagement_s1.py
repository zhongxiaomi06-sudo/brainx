"""S1 验收测试：承接状态机 + 事件账本（开发文档 v2.0 §11 S1）。

验收口径：
- 非法转移被拒；重复点击不产生重复事件；
- ACCEPTED 不被 90 天规则退回；WATCHED 超限被拒。
另覆盖：reason_code 强制、冷却期推荐阻断、自动补链、历史迁移映射、
投影重建一致性、命令端点鉴权与顾问隔离。
"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from decision import commands
from decision.api import CommandPayload, _require_actor, _run_command
from decision.engagement import CommandError
from decision.event_store import MemoryStore, rebuild_projection
from fastapi import HTTPException
from scripts.migrate_adoption_to_events import migrate as migrate_adoptions

NOW = datetime(2026, 8, 5, 10, 0, 0)


def cmd(store, command, fp="fp1", consultant="ashley", **kw):
    return commands.execute_command(
        store, command,
        consultant_id=consultant, opportunity_id=fp,
        idempotency_key=kw.pop("idempotency_key", f"{command}:{consultant}:{fp}"),
        now=kw.pop("now", NOW), **kw,
    )


class CommandServiceTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()

    def test_happy_path_chains_and_states(self):
        result = cmd(self.store, "watch")  # RECOMMENDED 不存在 → NEW 起链
        self.assertEqual(result["state"], "WATCHED")
        types = [e["event_type"] for e in result["events"]]
        self.assertEqual(types, ["RECOMMENDED", "VIEWED", "WATCHED"])  # 自动补链落账
        result = cmd(self.store, "accept")
        self.assertEqual(result["state"], "ACCEPTED")
        result = cmd(self.store, "complete", outcome_summary="已入职")
        self.assertEqual(result["state"], "COMPLETED")

    def test_illegal_transitions_rejected(self):
        with self.assertRaises(CommandError):
            cmd(self.store, "release")  # NEW 不能 release
        with self.assertRaises(CommandError):
            cmd(self.store, "expire")   # EXPIRED 只能从 WATCHED
        cmd(self.store, "watch")
        with self.assertRaises(CommandError):
            cmd(self.store, "view")     # WATCHED 不能退回 VIEWED
        cmd(self.store, "accept")
        with self.assertRaises(CommandError):
            # 换幂等键避开去重短路，真正打到状态校验：ACCEPTED 不能退回 WATCHED
            cmd(self.store, "watch", idempotency_key="watch:ashley:fp1:again")
        cmd(self.store, "release", reason_code="客户暂停")
        with self.assertRaises(CommandError):
            cmd(self.store, "dismiss", reason_code="x")  # 终态不可再操作

    def test_reason_code_required(self):
        with self.assertRaises(CommandError):
            cmd(self.store, "dismiss")  # 无 reason_code
        cmd(self.store, "watch")
        cmd(self.store, "accept")
        with self.assertRaises(CommandError):
            cmd(self.store, "release")

    def test_duplicate_click_no_duplicate_event(self):
        first = cmd(self.store, "watch", idempotency_key="watch:ashley:fp1:2026-08-05")
        second = cmd(self.store, "watch", idempotency_key="watch:ashley:fp1:2026-08-05")
        self.assertTrue(second["already"])
        self.assertEqual(first["event_id"], second["event_id"])
        events = self.store.list_events("ashley", "fp1")
        watched = [e for e in events if e["event_type"] == "WATCHED"]
        self.assertEqual(len(watched), 1)

    def test_accepted_never_expired_by_90_day_rule(self):
        cmd(self.store, "watch", now=NOW)
        cmd(self.store, "accept", now=NOW)
        far = NOW + timedelta(days=365)
        expired = commands.expire_stale(self.store, "ashley", now=far)
        self.assertEqual(expired, [])
        self.assertEqual(self.store.get_engagement("ashley", "fp1")["state"], "ACCEPTED")

    def test_watched_expires_only_after_90_days(self):
        cmd(self.store, "watch", now=NOW)
        self.assertEqual(commands.expire_stale(self.store, "ashley", now=NOW + timedelta(days=89)), [])
        expired = commands.expire_stale(self.store, "ashley", now=NOW + timedelta(days=91))
        self.assertEqual(len(expired), 1)
        self.assertEqual(self.store.get_engagement("ashley", "fp1")["state"], "EXPIRED")

    def test_watch_cap_enforced(self):
        with patch.dict(os.environ, {"TTC_DECISION_WATCH_CAP": "3"}):
            for i in range(3):
                cmd(self.store, "watch", fp=f"fp{i}")
            with self.assertRaises(CommandError) as ctx:
                cmd(self.store, "watch", fp="fp-overflow")
            self.assertIn("关注位已满", str(ctx.exception))

    def test_dismiss_cooldown_blocks_then_allows_recommend(self):
        cmd(self.store, "watch")
        cmd(self.store, "dismiss", reason_code="客户不靠谱", now=NOW)
        blocked = commands.recommendable_fingerprints(self.store, "ashley", now=NOW + timedelta(days=29))
        self.assertIn("fp1", blocked)
        with self.assertRaises(CommandError):
            cmd(self.store, "recommend", now=NOW + timedelta(days=29))  # 冷却期内重推被拒
        allowed = commands.recommendable_fingerprints(self.store, "ashley", now=NOW + timedelta(days=31))
        self.assertNotIn("fp1", allowed)
        result = cmd(self.store, "recommend", now=NOW + timedelta(days=31))
        self.assertEqual(result["state"], "RECOMMENDED")

    def test_accepted_and_completed_blocked_from_recommend(self):
        cmd(self.store, "watch")
        cmd(self.store, "accept")
        blocked = commands.recommendable_fingerprints(self.store, "ashley", now=NOW)
        self.assertIn("fp1", blocked)

    def test_consultant_isolation(self):
        cmd(self.store, "watch", fp="fpA", consultant="ashley")
        cmd(self.store, "recommend", fp="fpA", consultant="bob")
        cmd(self.store, "dismiss", fp="fpA", consultant="bob", reason_code="x")
        self.assertEqual(self.store.get_engagement("ashley", "fpA")["state"], "WATCHED")
        self.assertEqual(self.store.get_engagement("bob", "fpA")["state"], "DISMISSED")
        self.assertNotIn("fpA", commands.recommendable_fingerprints(self.store, "ashley", now=NOW))


class ProjectionRebuildTests(unittest.TestCase):
    def test_rebuild_matches_live_projection(self):
        store = MemoryStore()
        cmd(store, "watch", fp="fp1")
        cmd(store, "accept", fp="fp1")
        cmd(store, "recommend", fp="fp2")
        cmd(store, "dismiss", fp="fp2", reason_code="x")
        rebuilt = rebuild_projection(store)
        live = {key: row for key, row in store.engagements.items()}
        for key, row in rebuilt.items():
            self.assertEqual(row["state"], live[key]["state"], key)
            self.assertEqual(row["state_version"], live[key]["state_version"], key)

    def test_correction_event_does_not_change_state(self):
        store = MemoryStore()
        result = cmd(store, "watch", fp="fp1")
        correction = {
            "event_id": "corr-1", "consultant_id": "ashley", "opportunity_id": "fp1",
            "event_type": "CORRECTION", "previous_state": "", "next_state": "",
            "actor": "ashley", "reason_code": "", "metadata_json": {"fix": "reason"},
            "policy_version": "", "occurred_at": NOW, "recorded_at": NOW,
            "idempotency_key": "corr:1",
        }
        store.append_event(correction)
        rebuilt = rebuild_projection(store)
        self.assertEqual(rebuilt[("ashley", "fp1")]["state"], "WATCHED")
        self.assertEqual(len(store.list_events("ashley", "fp1")), len(result["events"]) + 1)

    def test_replay_order_is_insertion_order_even_with_tied_timestamps(self):
        """RDS 冒烟发现的真 bug 的回归锁：补链事件 occurred_at 全部相同时，
        回放必须按插入顺序（MySQL 侧由 seq AUTO_INCREMENT 保证），而非 event_id 排序。"""
        store = MemoryStore()
        result = cmd(store, "accept", fp="fp1")  # NEW 起链 4 事件同 occurred_at
        tied = {e["occurred_at"] for e in result["events"]}
        self.assertEqual(len(tied), 1)
        store2 = MemoryStore()
        for event in reversed(result["events"]):  # 乱序插入会改变 event_id 相对顺序
            store2.events.append(dict(event))
        rebuilt = rebuild_projection(store)  # 插入序回放
        self.assertEqual(rebuilt[("ashley", "fp1")]["state"], "ACCEPTED")
        # 证明乱序存储确实会产生不同终态（测试有效性）
        rebuilt2 = rebuild_projection(store2)
        self.assertEqual(rebuilt2[("ashley", "fp1")]["state"], "RECOMMENDED")


class LegacyMigrationTests(unittest.TestCase):
    def test_adopted_ignored_mapping_idempotent(self):
        store = MemoryStore()
        rows = [
            {"recommendation_id": 1, "request_id": "r1", "event_type": "adopted", "actor": "ashley",
             "detail_json": "{}", "created_at": NOW, "job_signal_fingerprint": "fp1", "consultant": "ashley"},
            {"recommendation_id": 2, "request_id": "r2", "event_type": "ignored", "actor": "ashley",
             "detail_json": '{"ignore_reason": "岗位不匹配"}', "created_at": NOW,
             "job_signal_fingerprint": "fp2", "consultant": "ashley"},
            {"recommendation_id": 3, "request_id": "r3", "event_type": "unknown", "actor": "ashley",
             "detail_json": None, "created_at": NOW, "job_signal_fingerprint": "fp3", "consultant": "ashley"},
        ]
        result = migrate_adoptions(store, rows)
        self.assertEqual(result, {"migrated": 2, "skipped": 1})
        # 重复执行幂等
        again = migrate_adoptions(store, rows)
        self.assertEqual(again, {"migrated": 0, "skipped": 3})
        events = store.all_events()
        by_fp = {e["opportunity_id"]: e for e in events}
        self.assertEqual(by_fp["fp1"]["event_type"], "ACCEPTED")
        self.assertEqual(by_fp["fp2"]["event_type"], "DISMISSED")
        self.assertEqual(by_fp["fp2"]["reason_code"], "岗位不匹配")


class ApiAuthTests(unittest.TestCase):
    def test_actor_header_required(self):
        with self.assertRaises(HTTPException) as ctx:
            _require_actor(None, None)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_token_checked_when_configured(self):
        with patch.dict(os.environ, {"RELOOP_API_TOKEN": "secret"}):
            with self.assertRaises(HTTPException) as ctx:
                _require_actor("ashley", "Bearer wrong")
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertEqual(_require_actor("ashley", "Bearer secret"), "ashley")

    def test_token_optional_when_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RELOOP_API_TOKEN", None)
            self.assertEqual(_require_actor("ashley", None), "ashley")

    def test_command_endpoint_maps_domain_error_to_409(self):
        payload = CommandPayload(fingerprint="fp1", idempotency_key="k1")
        with patch("decision.api.db.get_conn") as get_conn, \
             patch("decision.api.decision_commands.execute_command", side_effect=CommandError("非法状态转移: NEW → RELEASED")):
            from contextlib import contextmanager

            @contextmanager
            def fake_conn():
                yield FakeConn()

            get_conn.side_effect = fake_conn
            with self.assertRaises(HTTPException) as ctx:
                _run_command("release", payload, "ashley")
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertIn("非法状态转移", str(ctx.exception.detail))


class FakeCursor:
    description = []
    def execute(self, *_a): pass
    def fetchone(self): return None
    def fetchall(self): return []
    def __enter__(self): return self
    def __exit__(self, *_a): pass


class FakeConn:
    def cursor(self): return FakeCursor()
    def commit(self): pass


if __name__ == "__main__":
    unittest.main()
