import unittest
from datetime import date
from contextlib import contextmanager
from unittest.mock import patch

from decision.api import stats


class Cursor:
    description = [("rec_date",), ("sent_at",), ("status",)]
    def execute(self, *_args): pass
    def fetchall(self): return [(date(2026, 8, 3), "2026-08-03 09:00:00", "adopted"), (date(2026, 8, 3), None, "pending")]
    def __enter__(self): return self
    def __exit__(self, *_args): pass


class Connection:
    def cursor(self): return Cursor()


class DecisionApiTests(unittest.TestCase):
    def test_stats_denominator_zero_returns_null(self):
        @contextmanager
        def connection(): yield Connection()
        with patch("decision.api.db.get_conn", lambda: connection()):
            result = stats(days=7)
        self.assertEqual(result["pushed"], 1)
        self.assertEqual(result["response_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
