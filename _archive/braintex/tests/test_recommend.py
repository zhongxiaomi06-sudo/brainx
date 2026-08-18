import json
import unittest
from unittest.mock import patch

from decision.recommend import normalize_jd_text


class RecommendTests(unittest.TestCase):
    def test_normalize_counts_only_meaningful_keywords(self):
        text, count = normalize_jd_text({"job_title": "AI", "company": "X", "keywords_json": json.dumps(["A", "Agent", " RAG ", ""], ensure_ascii=False), "excerpt": "急招"})
        self.assertEqual(count, 2)
        self.assertIn("关键词：Agent RAG", text)

    def test_malformed_and_duplicate_keywords_fail_closed(self):
        _text, count = normalize_jd_text({"job_title": "AI", "keywords_json": '{"bad": true}'})
        self.assertEqual(count, 0)
        _text, count = normalize_jd_text({"job_title": "AI", "keywords_json": json.dumps(["Agent", " agent ", 123, None])})
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
