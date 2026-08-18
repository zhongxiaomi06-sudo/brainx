import os
import unittest
from unittest.mock import patch

from decision.push_card import build_card


class PushCardTests(unittest.TestCase):
    def test_payload_contains_actions_and_all_reasons(self):
        rec = {
            "id": 3, "rec_date": "2026-08-03", "job_title": "高级 Java", "company": "某公司", "total_score": 78.5,
            "reasons_json": '{"dimensions": [{"name":"freshness","score":100,"weight":0.25,"weighted":25,"reason":"信号新鲜"},{"name":"salary_fit","score":90,"weight":0.2,"weighted":18,"reason":"薪资完整"}]}',
            "trial_candidates_json": '[{"name":"张三","score":82,"evidence":["8年 Java"]}]',
        }
        with patch.dict(os.environ, {"TTC_DECISION_HMAC_SECRET": "unit-secret"}):
            payload = build_card(rec, "http://127.0.0.1:8765", 1, 1)
        self.assertEqual(payload["msg_type"], "interactive")
        text = str(payload)
        self.assertIn("信号新鲜", text)
        self.assertIn("薪资完整", text)
        self.assertIn("action=adopt", text)
        self.assertIn("action=ignore", text)

    def test_low_signal_notice_only_leads_first_card(self):
        rec = {"id": 4, "rec_date": "2026-08-03", "job_title": "AI", "company": "公司", "total_score": 60,
               "reasons_json": '{"dimensions": []}', "trial_candidates_json": "[]"}
        with patch.dict(os.environ, {"TTC_DECISION_HMAC_SECRET": "unit-secret"}):
            first = str(build_card(rec, "http://127.0.0.1:8765", 1, 1))
            later = str(build_card(rec, "http://127.0.0.1:8765", 2, 1))
        self.assertIn("今日有效岗位信号仅 1 条", first)
        self.assertNotIn("今日有效岗位信号仅", later)


if __name__ == "__main__":
    unittest.main()
