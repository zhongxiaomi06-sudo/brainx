"""S7 验收测试：飞书连接（每人自己的驾驶舱 → 共享 RDS job_signals）。

验收口径（2026-08-06 用户拍板）：
- 工作台一键「连接飞书」走 lark-cli 设备流（--no-wait 拿链接 + --device-code 轮询）；
- 登录后自动发现本人在的驾驶舱/职位市场/人才市场/SA-/SN- 群并采集岗位信号；
- 指纹 md5(group_chat:chat_id:title:company) 与采集人无关 → 多人采集同一岗位天然去重；
- evidence_json 带 collected_by 归属 + chat_name，摘录原文透传（不脱敏）；
- 同步并发安全（重入返回 already_running）、未登录拒绝采集；
- API：connect/sync 强制 X-Actor；lark-cli 缺失返回可执行错误。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest import mock
from unittest.mock import patch

from fastapi import HTTPException

from decision import api, feishu_link
from decision.feishu_link import FeishuLinkError, JobCluster, Msg

LOCAL_TZ = feishu_link.LOCAL_TZ
NOW = datetime(2026, 8, 6, 10, 0, 0, tzinfo=LOCAL_TZ)


def _msg(text: str, minutes_ago: int = 60, sender: str = "同事A", msg_type: str = "text",
         mid: str = "") -> Msg:
    return Msg(
        message_id=mid or f"m{text[:4]}{minutes_ago}",
        msg_type=msg_type,
        content=text,
        create_time=NOW - timedelta(minutes=minutes_ago),
        sender=sender,
    )


def _completed(stdout: str = "", stderr: str = "", code: int = 0):
    return subprocess_completed(stdout, stderr, code)


def subprocess_completed(stdout: str, stderr: str, code: int):
    class _P:
        pass
    p = _P()
    p.stdout = stdout
    p.stderr = stderr
    p.returncode = code
    return p


class LarkCliWrapperTests(unittest.TestCase):
    def test_missing_binary_raises(self):
        with patch.object(feishu_link, "lark_cli_path", return_value=None):
            with self.assertRaises(FeishuLinkError) as ctx:
                feishu_link.run_lark_raw(["auth", "status"])
            self.assertIn("lark_cli_not_installed", str(ctx.exception))

    def test_envelope_data_unwrapped(self):
        payload = {"ok": True, "data": {"items": [1, 2]}}
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch("subprocess.run", return_value=subprocess_completed(json.dumps(payload), "", 0)):
            self.assertEqual(feishu_link.run_lark(["im", "+chat-list"]), {"items": [1, 2]})

    def test_error_envelope_raises(self):
        payload = {"ok": False, "error": {"message": "boom"}}
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch("subprocess.run", return_value=subprocess_completed(json.dumps(payload), "", 0)):
            with self.assertRaises(FeishuLinkError):
                feishu_link.run_lark(["im", "+chat-list"])

    def test_nonzero_exit_raises_with_stderr(self):
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch("subprocess.run", return_value=subprocess_completed("", "permission denied", 1)):
            with self.assertRaises(FeishuLinkError) as ctx:
                feishu_link.run_lark_raw(["auth", "status"])
            self.assertIn("permission denied", str(ctx.exception))


class AuthStatusTests(unittest.TestCase):
    def test_not_installed(self):
        with patch.object(feishu_link, "lark_cli_path", return_value=None):
            s = feishu_link.auth_status()
            self.assertFalse(s["installed"])
            self.assertFalse(s["logged_in"])

    def test_ready_user(self):
        raw = {"identities": {"user": {"status": "ready", "tokenStatus": "valid",
                                       "userName": "Mia 钟笑咪", "openId": "ou_x"}}}
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "run_lark_raw", return_value=raw):
            s = feishu_link.auth_status()
            self.assertTrue(s["logged_in"])
            self.assertEqual(s["user_name"], "Mia 钟笑咪")

    def test_not_ready(self):
        raw = {"identities": {"user": {"status": "missing"}}}
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "run_lark_raw", return_value=raw):
            s = feishu_link.auth_status()
            self.assertFalse(s["logged_in"])
            self.assertTrue(s["configured"])

    def test_needs_refresh_still_logged_in(self):
        """access token 过期但 refresh 有效 = 已登录（lark-cli 调用时自动续期）。"""
        raw = {"identities": {"user": {
            "status": "needs_refresh", "tokenStatus": "needs_refresh",
            "userName": "Mia 钟笑咪", "refreshExpiresAt": "2099-08-13T11:44:32+08:00"}}}
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "run_lark_raw", return_value=raw):
            s = feishu_link.auth_status()
            self.assertTrue(s["logged_in"])
            self.assertEqual(s["user_name"], "Mia 钟笑咪")

    def test_refresh_expired_is_logged_out(self):
        raw = {"identities": {"user": {
            "status": "needs_refresh", "tokenStatus": "needs_refresh",
            "refreshExpiresAt": "2020-01-01T00:00:00+08:00"}}}
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "run_lark_raw", return_value=raw):
            self.assertFalse(feishu_link.auth_status()["logged_in"])

    def test_not_configured_machine(self):
        """同事全新机器：lark-cli 装了但没配 App 凭据 → configured=False（UI 引导初始化）。"""
        err = FeishuLinkError('{"error": {"subtype": "not_configured", "message": "not configured"}}')
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "run_lark_raw", side_effect=err):
            s = feishu_link.auth_status()
            self.assertTrue(s["installed"])
            self.assertFalse(s["configured"])
            self.assertFalse(s["logged_in"])


class ProvisionTests(unittest.TestCase):
    def test_secret_via_stdin_not_argv(self):
        """App Secret 必须走 stdin，绝不能出现在进程参数里（防 ps 泄露）。"""
        captured = {}

        def fake_run(cmd, **kw):
            captured["cmd"] = cmd
            captured["input"] = kw.get("input")
            return subprocess_completed("ok", "", 0)

        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch("subprocess.run", side_effect=fake_run), \
             patch.object(feishu_link, "auth_status", return_value={"logged_in": False}):
            feishu_link.provision("cli_abc", "s3cr3t-value")
        self.assertIn("--app-secret-stdin", captured["cmd"])
        self.assertEqual(captured["input"], "s3cr3t-value")
        self.assertNotIn("s3cr3t-value", captured["cmd"])

    def test_failure_raises(self):
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch("subprocess.run", return_value=subprocess_completed("", "bad secret", 1)):
            with self.assertRaises(FeishuLinkError):
                feishu_link.provision("cli_abc", "wrong-secret")

    def test_missing_binary(self):
        with patch.object(feishu_link, "lark_cli_path", return_value=None):
            with self.assertRaises(FeishuLinkError):
                feishu_link.provision("cli_abc", "s3cr3t-value")


class DeviceFlowTests(unittest.TestCase):
    def test_start_parses_url_and_code(self):
        raw = {"device_code": "dc123", "verification_url": "https://accounts.feishu.cn/x", "expires_in": 600}
        with patch.object(feishu_link, "run_lark_raw", return_value=raw) as call:
            flow = feishu_link.start_device_login()
        self.assertEqual(flow["device_code"], "dc123")
        self.assertEqual(flow["verification_url"], "https://accounts.feishu.cn/x")
        args = call.call_args[0][0]
        self.assertIn("--no-wait", args)
        self.assertIn("--domain", args)

    def test_start_missing_fields_raises(self):
        with patch.object(feishu_link, "run_lark_raw", return_value={"unexpected": 1}):
            with self.assertRaises(FeishuLinkError):
                feishu_link.start_device_login()

    def test_wait_returns_auth_status(self):
        with patch.object(feishu_link, "run_lark_raw", return_value={}) as call, \
             patch.object(feishu_link, "auth_status", return_value={"logged_in": True}):
            out = feishu_link.wait_device_login("dc123")
        self.assertTrue(out["logged_in"])
        args = call.call_args[0][0]
        self.assertEqual(args[:3], ["auth", "login", "--device-code"])


class GroupDiscoveryTests(unittest.TestCase):
    def test_filters_cockpit_topology(self):
        chats = [
            {"chat_id": "oc_1", "name": "📌沐仞科技 x TTC客户群驾驶舱"},
            {"chat_id": "oc_2", "name": "职位市场"},
            {"chat_id": "oc_3", "name": "人才市场"},
            {"chat_id": "oc_4", "name": "SA-沐仞-技术"},
            {"chat_id": "oc_5", "name": "SN-脑利-CTO"},
            {"chat_id": "oc_6", "name": "周末羽毛球群"},
            {"chat_id": "oc_7", "name": "York团队"},
            {"chat_id": "", "name": "驾驶舱（无 id 丢弃）"},
        ]
        with patch.object(feishu_link, "list_my_groups", return_value=chats):
            groups = feishu_link.discover_signal_groups()
        ids = [g["chat_id"] for g in groups]
        self.assertEqual(ids, ["oc_1", "oc_2", "oc_3", "oc_4", "oc_5"])


class MsgParsingTests(unittest.TestCase):
    def test_time_formats(self):
        a = feishu_link._parse_msg_time("2026-08-06 09:30")
        b = feishu_link._parse_msg_time("2026-08-06 09:30:15")
        self.assertEqual((a.hour, a.minute), (9, 30))
        self.assertEqual(b.second, 15)
        self.assertIsNone(feishu_link._parse_msg_time("garbage"))
        self.assertIsNone(feishu_link._parse_msg_time(None))

    def test_substantive_rules(self):
        self.assertFalse(_msg("收到").is_substantive)
        self.assertFalse(_msg("1.").is_substantive)
        self.assertFalse(_msg("x" * 30, msg_type="system").is_substantive)
        self.assertTrue(_msg("客户要招一个增长负责人，预算充足，急招").is_substantive)
        self.assertFalse(_msg("![img](http://x/y.png)").is_substantive)


class ClusterTests(unittest.TestCase):
    def test_groups_by_title_and_merges_keywords(self):
        msgs = [
            _msg("急招增长负责人，HC 充足", 100, "同事A"),
            _msg("增长负责人这个岗位 JD 已更新", 90, "同事B"),
            _msg("招聘商业化产品经理，急招", 80, "同事A"),
        ]
        clusters = feishu_link.cluster_signals("oc_1", "沐仞驾驶舱", msgs, ["招聘", "急招", "HC", "JD"])
        titles = sorted(c.title for c in clusters)
        self.assertEqual(titles, ["商业化产品经理", "增长负责人"])
        growth = next(c for c in clusters if c.title == "增长负责人")
        self.assertEqual(len(growth.messages), 2)
        self.assertEqual(growth.keywords, {"急招", "HC", "JD"})
        self.assertEqual(growth.chat_name, "沐仞驾驶舱")

    def test_company_extraction(self):
        msgs = [_msg("公司：沐仞科技 在招投放经理，急招", 50)]
        clusters = feishu_link.cluster_signals("oc_1", "g", msgs, ["急招"])
        self.assertEqual(clusters[0].company, "沐仞科技")

    def test_fingerprint_stable_across_collectors(self):
        """同一群同一岗位，谁采都一样 → 多人汇集天然去重。"""
        mk = lambda: JobCluster(chat_id="oc_1", title="增长负责人", company="沐仞科技")
        self.assertEqual(mk().fingerprint(), mk().fingerprint())
        other = JobCluster(chat_id="oc_1", title="增长负责人", company="沐仞科技", chat_name="别名")
        self.assertEqual(mk().fingerprint(), other.fingerprint())
        diff = JobCluster(chat_id="oc_2", title="增长负责人", company="沐仞科技")
        self.assertNotEqual(mk().fingerprint(), diff.fingerprint())

    def test_classify_branches(self):
        def cl(texts, senders=None, ages=None):
            c = JobCluster(chat_id="oc_1")
            for i, t in enumerate(texts):
                c.messages.append(_msg(t, (ages or [60] * len(texts))[i],
                                       (senders or ["A", "B", "C"])[i % 3]))
            return c
        self.assertEqual(cl(["急招增长负责人预算充足", "这个岗位不招了关闭"]).classify(NOW), "closed")
        self.assertEqual(cl(["急招增长负责人预算充足"], senders=["A"]).classify(NOW), "fake_active")
        hot = cl(["急招增长负责人预算充足", "这个岗位JD已更新请查收", "商业化运营岗位也要人"],
                 ages=[30, 60, 120])
        self.assertEqual(hot.classify(NOW), "heating")
        fresh = cl(["急招增长负责人预算充足", "这个岗位JD已更新请查收"], ages=[60, 120])
        self.assertEqual(fresh.classify(NOW), "new")
        old = cl(["急招增长负责人预算充足", "这个岗位JD已更新请查收"], ages=[6000, 6100])
        self.assertEqual(old.classify(NOW), "cooling")
        mid = cl(["急招增长负责人预算充足", "这个岗位JD已更新请查收"], ages=[3000, 3500])
        self.assertEqual(mid.classify(NOW), "active")


class _FakeCur:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCur()

    def cursor(self):
        return self.cur

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class UpsertTests(unittest.TestCase):
    def test_upsert_params_and_attribution(self):
        cl = JobCluster(chat_id="oc_1", chat_name="沐仞驾驶舱", title="增长负责人", company="沐仞科技")
        cl.keywords = {"急招"}
        cl.messages = [_msg("急招增长负责人，电话 13522011639 直接打", 60),
                       _msg("这个岗位 JD 已更新请查收", 50, "同事B")]
        conn = _FakeConn()
        st = feishu_link.upsert_cluster(cl, NOW, "Mia 钟笑咪", conn)
        self.assertEqual(len(conn.cur.calls), 1)
        sql, params = conn.cur.calls[0]
        self.assertIn("ON DUPLICATE KEY UPDATE", sql)
        self.assertEqual(params[1], "group_chat")
        evidence = json.loads(params[8])
        self.assertEqual(evidence["collected_by"], "Mia 钟笑咪")  # 归属可追溯
        self.assertEqual(evidence["chat_name"], "沐仞驾驶舱")
        self.assertIn("13522011639", params[9])  # 摘录原文透传，不脱敏
        self.assertEqual(st, "new")


class RunSyncTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._env = patch.dict(os.environ, {"TTC_BRAINTEX_STATE_DIR": self._tmp.name})
        self._env.start()
        feishu_link._state.update({"running": False, "last_result": None, "login": None})
        if feishu_link._SYNC_LOCK.locked():
            feishu_link._SYNC_LOCK.release()

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def _happy(self):
        conn = _FakeConn()

        @contextmanager
        def fake_conn():
            yield conn

        msgs = [
            _msg("急招增长负责人，HC 充足", 100, "同事A"),
            _msg("这个增长负责人岗位 JD 已更新", 90, "同事B"),
        ]
        return patch.object(feishu_link, "auth_status",
                            return_value={"logged_in": True, "user_name": "Mia 钟笑咪"}), \
               patch.object(feishu_link, "discover_signal_groups",
                            return_value=[{"chat_id": "oc_1", "name": "沐仞驾驶舱"}]), \
               patch.object(feishu_link, "list_chat_messages", return_value=msgs), \
               patch("decision.db.get_conn", side_effect=fake_conn), conn

    def test_not_logged_in_refuses(self):
        with patch.object(feishu_link, "auth_status", return_value={"logged_in": False}):
            out = feishu_link.run_sync()
        self.assertFalse(out["ok"])
        self.assertIn("未登录", out["error"])

    def test_reentrant_returns_already_running(self):
        feishu_link._SYNC_LOCK.acquire()
        try:
            out = feishu_link.run_sync()
        finally:
            feishu_link._SYNC_LOCK.release()
        self.assertEqual(out.get("status"), "already_running")

    def test_happy_path_writes_and_records_state(self):
        p1, p2, p3, p4, conn = self._happy()
        with p1, p2, p3, p4:
            out = feishu_link.run_sync(trigger="manual")
        self.assertTrue(out["ok"])
        self.assertEqual(out["collector"], "Mia 钟笑咪")
        self.assertEqual(out["group_count"], 1)
        self.assertEqual(out["signal_count"], 1)
        self.assertEqual(sum(out["by_type"].values()), 1)
        self.assertEqual(len(conn.cur.calls), 1)
        self.assertTrue(feishu_link._state["last_result"]["ok"])

    def test_group_read_failure_isolated(self):
        p1, p2, _, p4, conn = self._happy()
        with p1, p2, \
             patch.object(feishu_link, "list_chat_messages", side_effect=FeishuLinkError("230002")), \
             p4:
            out = feishu_link.run_sync()
        self.assertTrue(out["ok"])
        self.assertEqual(out["signal_count"], 0)
        self.assertEqual(len(out["errors"]), 1)

    def test_begin_login_authorized_triggers_first_sync(self):
        synced = []

        class _InlineThread:
            def __init__(self, target=None, kwargs=None, **kw):
                self._t = target
                self._kw = kwargs or {}
            def start(self):
                self._t(**self._kw)

        with patch.object(feishu_link, "start_device_login",
                          return_value={"device_code": "dc", "verification_url": "https://x", "expires_in": 600}), \
             patch.object(feishu_link, "wait_device_login",
                          return_value={"logged_in": True, "user_name": "Mia 钟笑咪"}), \
             patch.object(feishu_link, "run_sync",
                          side_effect=lambda **kw: synced.append(kw) or {"ok": True}), \
             patch.object(feishu_link.threading, "Thread", _InlineThread):
            flow = feishu_link.begin_login()
        self.assertEqual(flow["verification_url"], "https://x")
        self.assertEqual(feishu_link._state["login"]["status"], "authorized")
        self.assertEqual(synced[0].get("trigger"), "login")


class FeishuApiTests(unittest.TestCase):
    def test_status_shape(self):
        with patch.object(feishu_link, "link_status",
                          return_value={"installed": True, "logged_in": False}):
            out = api.feishu_status()
        self.assertIn("installed", out)
        self.assertIn("logged_in", out)

    def test_connect_requires_actor(self):
        with self.assertRaises(HTTPException) as ctx:
            api.feishu_connect(x_actor=None, authorization=None)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_connect_without_lark_cli_gives_actionable_error(self):
        with patch.object(feishu_link, "lark_cli_path", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                api.feishu_connect(x_actor="mia", authorization=None)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("lark_cli_not_installed", ctx.exception.detail)

    def test_connect_already_logged_in(self):
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "auth_status",
                          return_value={"logged_in": True, "user_name": "Mia 钟笑咪"}):
            out = api.feishu_connect(x_actor="mia", authorization=None)
        self.assertTrue(out["already"])

    def test_connect_returns_verification_url(self):
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "auth_status", return_value={"logged_in": False}), \
             patch.object(feishu_link, "begin_login",
                          return_value={"verification_url": "https://x", "expires_in": 600}):
            out = api.feishu_connect(x_actor="mia", authorization=None)
        self.assertEqual(out["verification_url"], "https://x")

    def test_sync_background_start_and_busy(self):
        with patch.object(feishu_link, "run_sync_background", return_value=True):
            out = api.feishu_sync(x_actor="mia", authorization=None, background=True, since_days=3)
        self.assertEqual(out["status"], "started")
        with patch.object(feishu_link, "run_sync_background", return_value=False):
            out = api.feishu_sync(x_actor="mia", authorization=None, background=True, since_days=3)
        self.assertEqual(out["status"], "already_running")

    def test_sync_requires_actor(self):
        with self.assertRaises(HTTPException):
            api.feishu_sync(x_actor=None, authorization=None, background=True, since_days=3)

    def test_provision_requires_actor(self):
        payload = api.ProvisionPayload(app_id="cli_abc", app_secret="s3cr3t-value")
        with self.assertRaises(HTTPException) as ctx:
            api.feishu_provision(payload, x_actor=None, authorization=None)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_provision_success(self):
        payload = api.ProvisionPayload(app_id="cli_abc", app_secret="s3cr3t-value")
        with patch.object(feishu_link, "lark_cli_path", return_value="/bin/lark-cli"), \
             patch.object(feishu_link, "provision",
                          return_value={"logged_in": False, "configured": True}) as call:
            out = api.feishu_provision(payload, x_actor="colleague", authorization=None)
        self.assertTrue(out["ok"])
        call.assert_called_once_with("cli_abc", "s3cr3t-value", "feishu")


if __name__ == "__main__":
    unittest.main()
