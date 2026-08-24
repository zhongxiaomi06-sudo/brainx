"""S8 验收测试：同事上传简历 → 共享 cloud_candidates。

验收口径（2026-08-06 用户拍板「RDS 数据合并，用户能直接使用、上传数据」）：
- 文本提取：txt/md 直读（utf-8/gb18030），不支持类型显式报错；
- 字段提取：手机号/邮箱正则，姓名先文件名后正文前几行；
- 指纹纪律（R5 禁止自创）：文件 = sha256('sha256|<文件哈希>')，
  文本 = phone → name_company_title → raw_hash 兜底链；
- 写库：vendored upsert 与 cloud_sync 同 SQL；rowcount 1=inserted/2=updated；
  单文件失败隔离、明细返回（R7 不吞错）；同一文件重传只更新不新增；
- 归属：owner / first_collected_by_user_id / parsed_json.uploaded_by = 上传人 actor；
- API：缺 X-Actor 拒 400，类型/大小超限拒绝。
"""

from __future__ import annotations

import hashlib
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from decision import api, candidate_upload
from decision.candidate_upload import UploadParseError


def _txt(content: str, name: str = "张三-产品经理-13800001111.txt") -> tuple[str, bytes]:
    return name, content.encode("utf-8")


RESUME_TEXT = """张三
产品经理 | 某科技公司
手机：13800001111 邮箱：zhangsan@example.com
工作 8 年，主导过增长中台、投放系统建设。
"""


class ExtractTextTests(unittest.TestCase):
    def test_txt_utf8(self):
        self.assertEqual(candidate_upload.extract_text("a.txt", "你好世界".encode("utf-8")), "你好世界")

    def test_txt_gb18030(self):
        self.assertEqual(candidate_upload.extract_text("a.txt", "你好世界".encode("gb18030")), "你好世界")

    def test_unsupported_type(self):
        with self.assertRaises(UploadParseError):
            candidate_upload.extract_text("a.exe", b"MZ")

    def test_bad_encoding(self):
        with self.assertRaises(UploadParseError):
            candidate_upload.extract_text("a.txt", b"\xff\xfe\x00\x01raw")


class ParseFieldsTests(unittest.TestCase):
    def test_phone_email_name(self):
        f = candidate_upload.parse_fields(RESUME_TEXT, "张三-产品经理-13800001111.txt")
        self.assertEqual(f["phone"], "13800001111")
        self.assertEqual(f["email"], "zhangsan@example.com")
        self.assertEqual(f["name"], "张三")

    def test_name_from_filename_with_noise(self):
        f = candidate_upload.parse_fields("无姓名正文", "高级产品经理-莫小卿-工作10年-18566221840(1).pdf")
        self.assertEqual(f["name"], "莫小卿")
        self.assertEqual(f["phone"], "18566221840")  # 文件名里的手机号也能提取

    def test_name_skips_title_and_city_segments(self):
        """「(高级)资深Java开发工程师-北京-刘金杰-…」应取刘金杰，不是高级/北京。"""
        f = candidate_upload.parse_fields(
            "无姓名正文",
            "(高级)资深Java开发工程师-北京-刘金杰-工作10年-【脉脉招聘】.pdf",
        )
        self.assertEqual(f["name"], "刘金杰")

    def test_name_unidentifiable_returns_empty(self):
        """满篇岗位词时不硬猜，留空交给 missing_fields/质量闸门。"""
        f = candidate_upload.parse_fields("高级产品经理\n资深运营专家", "resume.txt")
        self.assertEqual(f["name"], "")

    def test_name_fallback_first_lines(self):
        f = candidate_upload.parse_fields("李四\n求职意向：增长负责人", "resume_001.txt")
        self.assertEqual(f["name"], "李四")

    def test_missing_phone(self):
        f = candidate_upload.parse_fields("王五\n经验丰富", "王五.txt")
        self.assertEqual(f["phone"], "")


class FingerprintTests(unittest.TestCase):
    def test_file_fingerprint_stable_by_content(self):
        a = candidate_upload.fingerprint_for_file(b"same content")
        b = candidate_upload.fingerprint_for_file(b"same content")
        c = candidate_upload.fingerprint_for_file(b"other content")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        expected = hashlib.sha256(
            ("sha256|" + hashlib.sha256(b"same content").hexdigest()).encode()
        ).hexdigest()
        self.assertEqual(a, expected)  # 与 models 链 attachment 级一致

    def test_text_fingerprint_phone_first(self):
        f1 = {"phone": "13800001111", "name": "张三"}
        f2 = {"phone": "13800001111", "name": "张某三"}  # 同号不同名仍同指纹
        self.assertEqual(candidate_upload.fingerprint_for_text(f1),
                         candidate_upload.fingerprint_for_text(f2))

    def test_text_fingerprint_fallback_chain(self):
        named = candidate_upload.fingerprint_for_text({"name": "张三", "current_company": "某厂"})
        raw_only = candidate_upload.fingerprint_for_text({"raw_text": "一些正文"})
        self.assertNotEqual(named, raw_only)


class _FakeCur:
    def __init__(self, rowcount: int = 1):
        self.calls = []
        self._rowcount = rowcount

    @property
    def rowcount(self):
        return self._rowcount

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    def __init__(self, rowcount: int = 1):
        self.cur = _FakeCur(rowcount)

    def cursor(self):
        return self.cur


class UploadFlowTests(unittest.TestCase):
    def test_insert_and_attribution(self):
        conn = _FakeConn(rowcount=1)
        out = candidate_upload.upload_resume_files([_txt(RESUME_TEXT)], "colleague_a", conn)
        self.assertTrue(out["ok"])
        self.assertEqual((out["inserted"], out["updated"], out["failed"]), (1, 0, 0))
        sql, params = conn.cur.calls[0]
        self.assertIn("ON DUPLICATE KEY UPDATE", sql)
        self.assertEqual(params["phone"], "13800001111")
        self.assertEqual(params["owner"], "colleague_a")
        self.assertIsNone(params["first_collected_by_user_id"])  # bigint 列只放插件数字 ID
        self.assertEqual(params["platform"], "braintex_upload")
        parsed = json.loads(params["parsed_json"])
        self.assertEqual(parsed["uploaded_by"], "colleague_a")
        self.assertEqual(params["missing_fields"], "[]")  # phone+email 都有

    def test_rerun_same_file_updates_not_duplicates(self):
        conn = _FakeConn(rowcount=2)  # pymysql：命中重复键更新
        out = candidate_upload.upload_resume_files([_txt(RESUME_TEXT)], "colleague_a", conn)
        self.assertEqual(out["updated"], 1)
        self.assertEqual(out["inserted"], 0)

    def test_per_file_failure_isolated(self):
        conn = _FakeConn()
        files = [_txt(RESUME_TEXT), ("坏文件.exe", b"MZ"), ("空.txt", b"short")]
        out = candidate_upload.upload_resume_files(files, "a", conn)
        self.assertEqual(out["inserted"], 1)
        self.assertEqual(out["failed"], 2)
        errors = [r for r in out["results"] if not r["ok"]]
        self.assertEqual(len(errors), 2)
        self.assertFalse(out["ok"])  # R7：有失败不粉饰

    def test_missing_phone_recorded(self):
        conn = _FakeConn()
        candidate_upload.upload_resume_files([("王五.txt", "王五\n经验丰富无联系方式，正文内容需要足够长才能通过最短长度校验。".encode())], "a", conn)
        _, params = conn.cur.calls[0]
        self.assertEqual(json.loads(params["missing_fields"]), ["phone", "email"])


class UploadApiTests(unittest.TestCase):
    def test_requires_actor(self):
        import asyncio

        class _F:
            filename = "a.txt"

            async def read(self):
                return b"x" * 40

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(api.upload_resume(files=[_F()], x_actor=None, authorization=None))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_rejects_bad_ext_and_oversize(self):
        import asyncio

        class _F:
            def __init__(self, name, data):
                self.filename = name
                self._d = data

            async def read(self):
                return self._d

        files = [_F("a.exe", b"MZ1234567890123456789012345678901234567890"),
                 _F("big.txt", b"x" * (api.MAX_UPLOAD_BYTES + 1))]
        out = asyncio.run(api.upload_resume(files=files, x_actor="a", authorization=None))
        self.assertEqual(out["failed"], 2)
        self.assertFalse(out["ok"])

    def test_happy_path_calls_upload(self):
        import asyncio

        class _F:
            filename = "张三.txt"

            async def read(self):
                return RESUME_TEXT.encode()

        fake_out = {"ok": True, "inserted": 1, "updated": 0, "failed": 0, "results": []}
        with patch.object(api.candidate_upload, "upload_resume_files", return_value=fake_out) as call, \
             patch.object(api.db, "get_conn") as gc:
            gc.return_value.__enter__ = lambda s: object()
            gc.return_value.__exit__ = lambda *a: False
            out = asyncio.run(api.upload_resume(files=[_F()], x_actor="colleague_a", authorization=None))
        self.assertTrue(out["ok"])
        self.assertEqual(out["uploader"], "colleague_a")
        self.assertEqual(call.call_args[0][1], "colleague_a")


if __name__ == "__main__":
    unittest.main()
