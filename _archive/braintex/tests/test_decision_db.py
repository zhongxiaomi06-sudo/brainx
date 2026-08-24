import os
import unittest
from pathlib import Path

SCHEMA = Path(__file__).resolve().parents[1] / "decision" / "schema.sql"  # braintex 独立项目布局


class DecisionSchemaTests(unittest.TestCase):
    def test_schema_declares_required_tables(self):
        sql = SCHEMA.read_text(encoding="utf-8")
        for table in ("recommendations", "weight_config", "adoption_events"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", sql)


@unittest.skipUnless(os.getenv("RUN_DECISION_INTEGRATION") == "1", "requires explicit RDS integration opt-in")
class DecisionDbIntegrationTests(unittest.TestCase):
    def test_schema_is_run_explicitly(self):
        self.skipTest("requires an explicitly configured RDS and a separate migration run")


if __name__ == "__main__":
    unittest.main()
