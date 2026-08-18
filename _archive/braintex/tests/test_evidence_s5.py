"""S5 验收测试：对外证据供给接口（开发文档 v2.0 §11 S5，2026-08-05 修订：不脱敏）。

验收口径：
- Felix 线用 20 条快照可消费（契约校验器全量通过）；
- 接口只读；**不脱敏**（2026-08-05 用户拍板覆盖 §14）：候选人 phone/email 原文透出、
  excerpt 原文透传，访问控制由强制鉴权负责。
另覆盖：契约形状、FactSource 过滤透传、原文透出断言、只读性构造约束。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta

from decision import evidence
from decision.trial_picker import PASS_SCORE

NOW = datetime(2026, 8, 5, 10, 0, 0)

_TOP_FIELDS = {"name", "score", "evidence", "fingerprint", "phone", "email"}


def _signal(fp, **overrides):
    base = {
        "fingerprint": fp,
        "job_title": "Java 架构师",
        "company": "某大厂",
        "signal_type": "heating",
        "last_seen_at": "2026-08-04 09:00:00",
        "keywords": ["Java", "微服务"],
        "excerpt": "急招，联系 13800001234 或 hr@example.com",
    }
    base.update(overrides)
    return base


def _candidate(i, score_text="Java 微服务 分布式 高并发 架构 缓存 队列 性能优化 系统设计"):
    return {"fingerprint": f"cand-{i}", "name": f"候选{i}",
            "raw_text": f"{score_text} " * 6, "phone": f"1380000{i:04d}",
            "email": f"cand{i}@example.com"}


class SupplyContractTests(unittest.TestCase):
    def test_contract_shape_exact(self):
        payload = evidence.build_supply_evidence(_signal("fp1"), [_candidate(i) for i in range(5)], now=NOW)
        self.assertEqual(evidence.validate_supply_contract(payload), [])
        self.assertEqual(set(payload), {"fingerprint", "as_of", "supply", "signal", "source", "schema_version"})
        self.assertEqual(payload["schema_version"], "evidence-1.0")
        self.assertEqual(payload["source"], "braintex")
        self.assertEqual(payload["supply"]["pass_score"], PASS_SCORE)
        self.assertEqual(set(payload["supply"]), {"hits", "pass_score", "distribution", "top"})
        self.assertLessEqual(len(payload["supply"]["top"]), 3)
        for person in payload["supply"]["top"]:
            self.assertEqual(set(person), _TOP_FIELDS)

    def test_no_masking_contact_passed_through(self):
        """不脱敏：候选人 phone/email 原文进证据，agent 可直接联系。"""
        payload = evidence.build_supply_evidence(_signal("fp1"), [_candidate(i) for i in range(3)], now=NOW)
        import json

        blob = json.dumps(payload, ensure_ascii=False)
        self.assertIn("13800000000", blob)          # 候选人手机号原文透出
        self.assertIn("cand0@example.com", blob)    # 候选人邮箱原文透出
        for person in payload["supply"]["top"]:
            self.assertTrue(person["phone"].startswith("1380000"))
            self.assertTrue(person["email"].endswith("@example.com"))
            self.assertEqual(person["fingerprint"], f"cand-{int(person['name'][2:])}")

    def test_signal_excerpt_raw(self):
        """不脱敏：job_signals excerpt 原文透传，手机号/邮箱不打码。"""
        rows = [_signal("fp1")]
        output = evidence.build_job_signals_factsource(rows, now=NOW)
        excerpt = output["items"][0]["excerpt"]
        self.assertIn("13800001234", excerpt)
        self.assertIn("hr@example.com", excerpt)
        self.assertNotIn("1**********", excerpt)
        self.assertNotIn("***@***", excerpt)

    def test_felix_consumes_20_snapshots(self):
        """验收：Felix 线用 20 条快照可消费——逐条过契约校验器。"""
        for i in range(20):
            payload = evidence.build_supply_evidence(
                _signal(f"fp-{i}", signal_type="new" if i % 2 else "heating"),
                [_candidate(j) for j in range(i % 5)],
                now=NOW - timedelta(hours=i),
            )
            errors = evidence.validate_supply_contract(payload)
            self.assertEqual(errors, [], f"fp-{i}: {errors}")

    def test_empty_pool_is_valid_observe_shaped_payload(self):
        payload = evidence.build_supply_evidence(_signal("fp1"), [], now=NOW)
        self.assertEqual(evidence.validate_supply_contract(payload), [])
        self.assertEqual(payload["supply"]["hits"], 0)
        self.assertEqual(payload["supply"]["distribution"]["scored"], 0)


class FactSourceTests(unittest.TestCase):
    def test_shape_and_filter_echo(self):
        rows = [_signal(f"fp-{i}") for i in range(3)]
        output = evidence.build_job_signals_factsource(rows, now=NOW, since="2026-08-01", signal_type="heating")
        self.assertEqual(output["schema_version"], "evidence-1.0")
        self.assertEqual(output["source"], "braintex")
        self.assertEqual(output["filter"], {"since": "2026-08-01", "type": "heating"})
        self.assertEqual(output["count"], 3)
        for item in output["items"]:
            self.assertEqual(set(item), {"fingerprint", "job_title", "company", "signal_type",
                                         "keywords", "excerpt", "last_seen_at"})

    def test_keywords_json_string_parsed(self):
        row = _signal("fp1")
        del row["keywords"]
        row["keywords_json"] = '["Java", "微服务"]'
        output = evidence.build_job_signals_factsource([row], now=NOW)
        self.assertEqual(output["items"][0]["keywords"], ["Java", "微服务"])


class ValidatorTests(unittest.TestCase):
    def test_validator_catches_out_of_contract_fields(self):
        """校验器仍守契约边界：top 混入契约外字段要报违规。"""
        payload = evidence.build_supply_evidence(_signal("fp1"), [_candidate(1)], now=NOW)
        payload["supply"]["top"][0]["salary"] = "50k"  # 越界字段
        errors = evidence.validate_supply_contract(payload)
        self.assertTrue(any("越界字段" in e for e in errors))

    def test_validator_accepts_raw_contact(self):
        """不脱敏后，原文手机号/邮箱不再是违规项。"""
        payload = evidence.build_supply_evidence(_signal("fp1"), [_candidate(1)], now=NOW)
        payload["supply"]["top"][0]["evidence"] = ["联系 13912345678"]
        self.assertEqual(evidence.validate_supply_contract(payload), [])


if __name__ == "__main__":
    unittest.main()
