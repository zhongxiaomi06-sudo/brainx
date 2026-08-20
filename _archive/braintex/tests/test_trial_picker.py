import unittest

from decision.trial_picker import pick_trial, score_pool, supply_hits


class TrialPickerTests(unittest.TestCase):
    def test_short_text_is_skipped_and_top_three_are_sorted(self):
        candidates = [
            {"fingerprint": "low", "name": "短文本", "raw_text": "太短"},
            {"fingerprint": "a", "name": "甲", "raw_text": "Agent RAG 项目交付经验" * 10},
            {"fingerprint": "b", "name": "乙", "raw_text": "Agent 项目经验" * 10},
            {"fingerprint": "c", "name": "丙", "raw_text": "RAG 项目经验" * 10},
            {"fingerprint": "d", "name": "丁", "raw_text": "后台开发经验" * 10},
        ]
        scored = score_pool("岗位：AI 工程师\n关键词：Agent RAG", candidates)
        self.assertLessEqual(len(pick_trial(scored, pass_score=0, limit=3)), 3)
        self.assertNotIn("low", {item["fingerprint"] for item in scored})
        self.assertEqual(scored, sorted(scored, key=lambda x: (-x["score"], x["fingerprint"])))
        self.assertEqual(supply_hits(scored, 0), len(scored))
        self.assertTrue(all(0 <= item["score"] <= 100 for item in scored))
        self.assertTrue(all("evidence" in item for item in scored))


if __name__ == "__main__":
    unittest.main()
