import unittest
from datetime import datetime, timedelta

from decision.signal_scorer import DIMENSION_REGISTRY, score_signal


class SignalScorerTests(unittest.TestCase):
    def setUp(self):
        self.weights = {name: value for name, value in zip(DIMENSION_REGISTRY, (0.25, 0.2, 0.2, 0.25, 0.1))}
        self.now = datetime(2026, 8, 3, 10, 0, 0)

    def signal(self, **overrides):
        value = {"job_title": "AI 工程师", "company": "测试公司", "excerpt": "薪资 40-60k", "signal_type": "new", "last_seen_at": self.now - timedelta(hours=12)}
        value.update(overrides)
        return value

    def test_five_dimensions_and_deterministic_now(self):
        result = score_signal(self.signal(), self.weights, 4, self.now)
        self.assertEqual([item["name"] for item in result["dimensions"]], list(DIMENSION_REGISTRY))
        self.assertTrue(all(item["reason"] for item in result["dimensions"]))
        self.assertEqual(result, score_signal(self.signal(), self.weights, 4, self.now))

    def test_urgent_beats_nonurgent(self):
        urgent = score_signal(self.signal(job_title="AI 工程师急招", excerpt="尽快到岗"), self.weights, 0, self.now)
        normal = score_signal(self.signal(excerpt="薪资 40-60k"), self.weights, 0, self.now)
        self.assertGreater(urgent["total"], normal["total"])

    def test_cooling_halves_total_and_unknown_dimension_fails(self):
        normal = score_signal(self.signal(), self.weights, 2, self.now)
        cooling = score_signal(self.signal(signal_type="cooling"), self.weights, 2, self.now)
        self.assertEqual(cooling["total"], round(normal["total"] / 2, 1))
        with self.assertRaisesRegex(ValueError, "未知维度"):
            score_signal(self.signal(), {**self.weights, "bad": 0.1}, 0, self.now)

    def test_missing_timestamp_is_fail_closed(self):
        result = score_signal(self.signal(last_seen_at=None), self.weights, 0, self.now)
        freshness = next(item for item in result["dimensions"] if item["name"] == "freshness")
        self.assertEqual(freshness["score"], 0.0)
        self.assertIn("缺失", freshness["reason"])


if __name__ == "__main__":
    unittest.main()
