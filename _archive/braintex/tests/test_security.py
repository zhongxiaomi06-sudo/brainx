import os
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from decision.security import make_token, verify_token


class Cursor:
    def __init__(self, row): self.row = row
    def execute(self, *_args): pass
    def fetchone(self): return self.row
    def __enter__(self): return self
    def __exit__(self, *_args): pass


class Connection:
    def __init__(self, row): self.row = row
    def cursor(self): return Cursor(self.row)


class SecurityTests(unittest.TestCase):
    def test_roundtrip_and_tampering(self):
        with patch.dict(os.environ, {"TTC_DECISION_HMAC_SECRET": "unit-secret"}):
            token = make_token(12, "2026-08-03")
            with patch("decision.security.db.get_conn", lambda: _connection({"rec_date": "2026-08-03"})):
                self.assertEqual(verify_token(token), 12)
                with self.assertRaises(ValueError): verify_token(token[:-1] + "0")
                with self.assertRaises(ValueError): verify_token("13." + token.split(".", 1)[1])

    def test_missing_secret_is_explicit(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "未配置"): make_token(1, "2026-08-03")


def _connection(row):
    @contextmanager
    def manager():
        yield Connection(row)
    return manager()


if __name__ == "__main__":
    unittest.main()
