"""S9 验收测试：客户中心层（L0 归一人审 / L2 客户360 / L3 每日摘要）。

验收口径（2026-08-06 用户拍板）：
- 归一：大小写/空格/括号/公司后缀不造成重复客户（PixAI=Pix AI，沐仞=沐仞科技，
  深至=深至科技）；垃圾名（公司/TTC）不入档；containment 合并需 ≥2 字符；
- 人审：自动归一一律 pending，confirm/rename/merge 后才 confirmed；
- 客户 360：信号/承接/反馈/digest 从既有表聚合，无数据回 UNKNOWN 不回 0；
- digest：规则模板生成、幂等 upsert；确认/纠正写回账本（stage=digest_review），
  纠正必须带文本。
"""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from decision import api, clients


class NormalizeTests(unittest.TestCase):
    def test_case_and_space_variants(self):
        self.assertEqual(clients.normalize_core("PixAI"), clients.normalize_core("Pix AI"))
        self.assertEqual(clients.normalize_core("TinkerLand"), clients.normalize_core("Tinkerland（上海）"))

    def test_company_suffixes(self):
        self.assertEqual(clients.normalize_core("沐仞科技"), "沐仞")
        self.assertEqual(clients.normalize_core("深至科技"), clients.normalize_core("深至"))
        self.assertEqual(clients.normalize_core("稳准智能"), clients.normalize_core("稳准"))

    def test_stacked_suffixes(self):
        self.assertEqual(clients.normalize_core("某某智能科技公司"), "某某")

    def test_paren_stripped_but_aliased(self):
        self.assertEqual(clients.normalize_core("ActionX（北京雨林时代）"), "actionx")
        self.assertEqual(clients.extract_aliases("ActionX（北京雨林时代）"), ["北京雨林时代"])

    def test_cluster_merges_and_excludes_junk(self):
        names = ["PixAI", "Pix AI", "沐仞科技", "公司", "TTC", "OiiOii", "OiiOii 天码形空科技"]
        clusters = clients.cluster_companies(names)
        cores = set(clusters.keys())
        pixai_core = clients.normalize_core("PixAI")  # "ai" 视为公司后缀剥离，两变体同核即可
        self.assertEqual(pixai_core, clients.normalize_core("Pix AI"))
        self.assertIn(pixai_core, cores)
        self.assertIn("沐仞", cores)
        self.assertIn("oiioii", cores)
        self.assertNotIn("公司", cores)
        self.assertNotIn("ttc", cores)
        self.assertEqual(sorted(clusters[pixai_core]), ["Pix AI", "PixAI"])
        self.assertEqual(sorted(clusters["oiioii"]), ["OiiOii", "OiiOii 天码形空科技"])

    def test_canonical_picks_most_informative(self):
        self.assertEqual(clients.canonical_of(["OiiOii", "OiiOii 天码形空科技"]), "OiiOii 天码形空科技")
        self.assertEqual(clients.canonical_of(["沐仞科技", "沐仞"]), "沐仞科技")

    def test_cockpit_name_extract(self):
        m = clients.COCKPIT_NAME_RE.search("📌沐仞科技 x TTC客户群驾驶舱【内部群】")
        self.assertEqual(m.group(1), "沐仞科技")


class _ProgCur:
    """可编程游标：按 SQL 关键字返回预设行。"""

    def __init__(self, companies=None, client_row=None, aliases_target="[]"):
        self.companies = companies or []
        self.client_row = client_row
        self.aliases_target = aliases_target
        self.executed = []
        self.rowcount = 0

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if sql.strip().startswith("SELECT DISTINCT company"):
            self._fetch = [(c,) for c in self.companies]
        elif sql.strip().startswith("SELECT * FROM clients"):
            self._fetch = [self.client_row] if self.client_row else []
        elif sql.strip().startswith("SELECT aliases_json"):
            self._fetch = [(self.aliases_target,)]
        elif sql.strip().startswith("SHOW COLUMNS"):
            self._fetch = [(c,) for c in ("client_id", "core", "canonical_name", "aliases_json",
                                          "cockpit_chat_id", "review_status")]
        else:
            self._fetch = []
            self.rowcount = 1

    def fetchall(self):
        return getattr(self, "_fetch", [])

    def fetchone(self):
        rows = getattr(self, "_fetch", [])
        return rows[0] if rows else None

    @property
    def description(self):
        return []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _ProgConn:
    def __init__(self, cur):
        self._cur = cur

    def cursor(self):
        return self._cur


class SyncClientsTests(unittest.TestCase):
    def test_clusters_upserted_pending_with_cockpit_mapping(self):
        cur = _ProgCur(companies=["PixAI", "Pix AI", "沐仞科技", "公司"])
        conn = _ProgConn(cur)
        chats = [{"chat_id": "oc_1aca", "name": "📌沐仞科技 x TTC客户群驾驶舱【内部群】"}]
        out = clients.sync_clients_from_signals(conn, cockpit_chats=chats)
        self.assertEqual(out["clusters"], 2)  # pixai + 沐仞（公司被排除）
        self.assertEqual(out["inserted"], 2)
        self.assertEqual(out["cockpit_mapped"], 1)
        inserts = [p for sql, p in cur.executed if sql.strip().startswith("INSERT INTO clients")]
        by_core = {p[1]: p for p in inserts}
        pixai_core = clients.normalize_core("PixAI")
        self.assertEqual(by_core["沐仞"][4], "oc_1aca")  # 驾驶舱群已挂
        self.assertEqual(json.loads(by_core[pixai_core][3]), ["Pix AI", "PixAI"])
        self.assertEqual(by_core[pixai_core][4], "")  # 无驾驶舱群
        ins_sql = [sql for sql, _ in cur.executed if sql.strip().startswith("INSERT INTO clients")][0]
        self.assertIn("'pending'", ins_sql)  # 自动归一不直接 confirmed

    def test_rerun_is_idempotent_update(self):
        cur = _ProgCur(companies=["PixAI"])
        cur.rowcount = 2
        conn = _ProgConn(cur)
        out = clients.sync_clients_from_signals(conn)
        self.assertEqual(out["clusters"], 1)


class ReviewClientTests(unittest.TestCase):
    ROW = ("cid1", "pixai", "PixAI", '["PixAI","Pix AI"]', "oc_x", "pending")

    def test_confirm(self):
        cur = _ProgCur(client_row=self.ROW)
        out = clients.review_client(_ProgConn(cur), "cid1", "confirm", "mia")
        self.assertTrue(out["ok"])
        upd = [p for sql, p in cur.executed if sql.startswith("UPDATE clients SET review_status='confirmed'")]
        self.assertEqual(upd[0][0], "mia")

    def test_rename_requires_name(self):
        cur = _ProgCur(client_row=self.ROW)
        out = clients.review_client(_ProgConn(cur), "cid1", "rename", "mia")
        self.assertFalse(out["ok"])
        out = clients.review_client(_ProgConn(cur), "cid1", "rename", "mia", canonical_name="Pix AI")
        self.assertTrue(out["ok"])

    def test_merge_absorbs_aliases_and_deletes(self):
        cur = _ProgCur(client_row=self.ROW, aliases_target='["PixAI"]')
        out = clients.review_client(_ProgConn(cur), "cid1", "merge", "mia", merge_into="cid2")
        self.assertTrue(out["ok"])
        merge_upd = [p for sql, p in cur.executed if sql.startswith("UPDATE clients SET aliases_json")]
        self.assertIn("Pix AI", json.loads(merge_upd[0][0]))
        self.assertTrue(any(sql.startswith("DELETE FROM clients") for sql, _ in cur.executed))

    def test_unknown_client(self):
        cur = _ProgCur(client_row=None)
        out = clients.review_client(_ProgConn(cur), "nope", "confirm", "mia")
        self.assertEqual(out["error"], "client_not_found")


class DigestTests(unittest.TestCase):
    DETAIL = {
        "client": {"canonical_name": "PixAI"},
        "signals": [
            {"job_title": "增长负责人", "signal_type": "heating", "fingerprint": "f1",
             "first_seen_at": "2026-08-05 09:00:00", "last_seen_at": "2026-08-06 09:00:00"},
            {"job_title": "投放经理", "signal_type": "new", "fingerprint": "f2",
             "first_seen_at": "2026-08-06 08:00:00", "last_seen_at": "2026-08-06 09:30:00"},
            {"job_title": "老岗位", "signal_type": "cooling", "fingerprint": "f3",
             "first_seen_at": "2026-07-01 08:00:00", "last_seen_at": "2026-07-02 09:30:00"},
        ],
        "engagements": [], "outcomes": [], "digests": [],
    }

    def test_digest_content_and_idempotent_upsert(self):
        cur = _ProgCur()
        with patch.object(clients, "client_detail", return_value=self.DETAIL):
            out = clients.generate_digest(_ProgConn(cur), "cid1", day="2026-08-06")
        self.assertTrue(out["ok"])
        self.assertIn("PixAI", out["summary"])
        self.assertIn("新增 1 个岗位信号", out["summary"])  # 投放经理 first_seen 24h 内
        self.assertIn("升温", out["summary"])
        self.assertEqual(out["changes"]["heating"], 1)
        ins = [sql for sql, _ in cur.executed if sql.strip().startswith("INSERT INTO client_digest")]
        self.assertIn("ON DUPLICATE KEY UPDATE", ins[0])  # 幂等

    def test_digest_no_signal_says_unknown_not_zero(self):
        detail = {"client": {"canonical_name": "空客户"}, "signals": [],
                  "engagements": [], "outcomes": [], "digests": []}
        cur = _ProgCur()
        with patch.object(clients, "client_detail", return_value=detail):
            out = clients.generate_digest(_ProgConn(cur), "cid1", day="2026-08-06")
        self.assertIn("无新动态", out["summary"])


class ClientsApiTests(unittest.TestCase):
    def test_review_requires_actor(self):
        payload = api.ClientReviewPayload(client_id="c1", action="confirm")
        with self.assertRaises(HTTPException) as ctx:
            api.clients_review(payload, x_actor=None, authorization=None)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_digest_review_correct_requires_text(self):
        payload = api.DigestReviewPayload(client_id="c1", digest_date="2026-08-06", action="correct")
        with self.assertRaises(HTTPException) as ctx:
            api.clients_digest_review(payload, x_actor="mia", authorization=None)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_digest_review_writes_ledger(self):
        payload = api.DigestReviewPayload(client_id="c1", digest_date="2026-08-06",
                                          action="correct", corrected_text="实际新增 2 个")

        class _Cur(_ProgCur):
            rowcount = 1

            def execute(self, sql, params=None):
                super().execute(sql, params)
                self.rowcount = 1

        class _Conn:
            def cursor(self):
                return _Cur()

            def commit(self):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with patch.object(api.db, "get_conn", return_value=_Conn()), \
             patch.object(api.decision_commands, "record_outcome", return_value={"ok": True}) as rec:
            out = api.clients_digest_review(payload, x_actor="mia", authorization=None)
        self.assertTrue(out["ok"])
        kw = rec.call_args.kwargs
        self.assertEqual(kw["stage"], "digest_review")
        self.assertEqual(kw["opportunity_id"], "client:c1")
        self.assertEqual(kw["value"]["rating"], 2)  # 纠正=不满意信号，喂养调权


if __name__ == "__main__":
    unittest.main()
