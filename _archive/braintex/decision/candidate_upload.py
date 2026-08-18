"""同事上传简历 → 共享 cloud_candidates（与 candidate-collector 同一套纪律）。

纪律：
- 指纹禁止自创算法（R5）：文件走 models 链——attachment_sha256 优先；
  粘贴文本走兜底链——phone → name_company_title → raw_hash。
- 写库 SQL 与 cloud_sync.client.upsert_candidates 逐字一致（vendored；
  源：ttc 交易系统 candidate-collector/cloud_sync/client.py）。
- R7：每个文件的失败明细显式返回，绝不静默吞。
- 数据不脱敏（用户拍板）：phone/email 原文入库；归属 uploaded_by 记录上传人。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

LOCAL_TZ = timezone(timedelta(hours=8))

PHONE_RE = re.compile(r"1[3-9]\d{9}")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
CJK_NAME_RE = re.compile(r"[一-龥]{2,4}")
FILENAME_NOISE = re.compile(
    r"简历|resume|CV|应聘|求职|更新版|最新|最终版?|v\d+|副本|copy", re.I
)
# 姓名提取噪声词：岗位词/城市/渠道/程度词，含这些词的片段不是人名
TITLE_NOISE = re.compile(
    r"高级|资深|初级|专家|北京|上海|深圳|杭州|广州|成都|西安|南京|"
    r"工程师|经理|总监|开发|产品|运营|专员|主管|顾问|分析师|设计师|"
    r"招聘|工作|测试|简历|脉脉|猎聘|实习|应届"
)


class UploadParseError(RuntimeError):
    """单份文件解析失败。"""


# ── 文本提取 ────────────────────────────────────────────────────
def extract_text(filename: str, data: bytes) -> str:
    """按扩展名提取纯文本。支持 pdf/docx/txt/md。"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "pdf":
        try:
            from pypdf import PdfReader
        except ImportError as exc:  # pragma: no cover
            raise UploadParseError("pypdf 未安装") from exc
        try:
            import io

            reader = PdfReader(io.BytesIO(data))
            return "\n".join((p.extract_text() or "") for p in reader.pages).strip()
        except Exception as exc:
            raise UploadParseError(f"PDF 解析失败: {str(exc)[:120]}") from exc
    if ext == "docx":
        try:
            import docx
        except ImportError as exc:  # pragma: no cover
            raise UploadParseError("python-docx 未安装") from exc
        try:
            import io

            doc = docx.Document(io.BytesIO(data))
            return "\n".join(p.text for p in doc.paragraphs).strip()
        except Exception as exc:
            raise UploadParseError(f"DOCX 解析失败: {str(exc)[:120]}") from exc
    if ext in ("txt", "md", "text"):
        for enc in ("utf-8", "gb18030"):
            try:
                return data.decode(enc).strip()
            except UnicodeDecodeError:
                continue
        raise UploadParseError("文本编码无法识别（非 utf-8/gb18030）")
    raise UploadParseError(f"不支持的文件类型: .{ext}（支持 pdf/docx/txt/md）")


# ── 字段提取 ────────────────────────────────────────────────────
def extract_name(text: str, filename: str) -> str:
    """先文件名后正文前几行：取 2-4 个连续中文、且不含岗位/城市噪声词的片段。"""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    stem = FILENAME_NOISE.sub("-", stem)
    for seg in re.split(r"[-—_\s()（）\[\]【】]+", stem):
        seg = seg.strip()
        if CJK_NAME_RE.fullmatch(seg) and not TITLE_NOISE.search(seg):
            return seg
    for line in text.splitlines()[:6]:
        line = line.strip()
        if CJK_NAME_RE.fullmatch(line) and not TITLE_NOISE.search(line):
            return line
    for m in CJK_NAME_RE.finditer(text[:200]):
        if not TITLE_NOISE.search(m.group(0)):
            return m.group(0)
    return ""


def parse_fields(text: str, filename: str) -> dict[str, Any]:
    phone_m = PHONE_RE.search(text) or PHONE_RE.search(filename)
    email_m = EMAIL_RE.search(text)
    return {
        "name": extract_name(text, filename),
        "phone": phone_m.group(0) if phone_m else "",
        "email": email_m.group(0) if email_m else "",
        "raw_text": text,
    }


# ── 指纹（R5 唯一纪律，禁止自创） ────────────────────────────────
def fingerprint_for_file(data: bytes) -> str:
    """文件：models 链 attachment_sha256 级——sha256('sha256|<文件内容哈希>')。"""
    file_hash = hashlib.sha256(data).hexdigest()
    return hashlib.sha256(f"sha256|{file_hash}".encode("utf-8")).hexdigest()


def fingerprint_for_text(fields: dict[str, Any]) -> str:
    """粘贴文本：_fallback 链——phone → name_company_title → raw_hash。"""
    if fields.get("phone"):
        return hashlib.sha256(f"phone|{fields['phone']}".encode("utf-8")).hexdigest()
    parts = [fields.get("name") or "", fields.get("current_company") or "", fields.get("current_role") or ""]
    if any(parts):
        raw = "name_company_title|" + "|".join(parts)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()
    raw_text = fields.get("raw_text") or ""
    raw = "raw_hash|" + hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ── 行构造 + 写库（vendored upsert，与 cloud_sync 同一 SQL） ────
def build_row(fields: dict[str, Any], fingerprint: str, uploader: str,
              source_name: str = "") -> dict[str, Any]:
    now = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S")
    missing = [k for k in ("phone", "email") if not fields.get(k)]
    return {
        "fingerprint": fingerprint,
        "name": fields.get("name") or "",
        "platform": "braintex_upload",
        "source_candidate_id": "",
        "source_url": "",
        "source_type": "colleague_upload",
        "title": "",
        "location": "",
        "current_company": "",
        "current_role": "",
        "phone": fields.get("phone") or "",
        "email": fields.get("email") or "",
        "undergraduate_school": "",
        "expected_salary": "",
        "experiences_json": "[]",
        "education_json": "[]",
        "keywords_json": "[]",
        "raw_text": fields.get("raw_text") or "",
        "review_status": "pending",
        "attachment_path": "",
        "attachment_sha256": "",
        "collected_at": now,
        "parsed_json": json.dumps(
            {"uploaded_by": uploader, "source_name": source_name, "via": "braintex_workbench"},
            ensure_ascii=False,
        ),
        "first_collected_by_user_id": None,  # bigint 列，插件数字用户 ID 专用；上传人归属在 owner/parsed_json
        "activity_score": 0,
        "activity_signals": "{}",
        "owner": uploader,
        "visibility": "team",
        "starred": 0,
        "last_active_at": None,
        "quality_score": 0,
        "missing_fields": json.dumps(missing, ensure_ascii=False),
        "expected_title": "",
        "opportunity_intent": "",
    }


UPSERT_SQL = """
INSERT INTO cloud_candidates (
    fingerprint, name, platform, source_candidate_id, source_url, source_type, title,
    location, current_company, current_role, phone, email,
    undergraduate_school, expected_salary, experiences_json,
    education_json, keywords_json, raw_text, review_status,
    attachment_path, attachment_sha256, collected_at, parsed_json,
    first_collected_by_user_id, activity_score, activity_signals,
    owner, visibility, starred, last_active_at,
    quality_score, missing_fields, expected_title, opportunity_intent
) VALUES (
    %(fingerprint)s, %(name)s, %(platform)s, %(source_candidate_id)s, %(source_url)s,
    %(source_type)s, %(title)s, %(location)s, %(current_company)s,
    %(current_role)s, %(phone)s, %(email)s, %(undergraduate_school)s,
    %(expected_salary)s, %(experiences_json)s, %(education_json)s,
    %(keywords_json)s, %(raw_text)s, %(review_status)s,
    %(attachment_path)s, %(attachment_sha256)s, %(collected_at)s,
    %(parsed_json)s, %(first_collected_by_user_id)s, %(activity_score)s,
    %(activity_signals)s, %(owner)s, %(visibility)s, %(starred)s,
    %(last_active_at)s,
    %(quality_score)s, %(missing_fields)s, %(expected_title)s, %(opportunity_intent)s
)
ON DUPLICATE KEY UPDATE
    -- 非破坏性合并：只补空缺，不覆盖已有富解析数据（轻量通道不得降级 canonical 行）
    name = IF(name IS NULL OR name = '', VALUES(name), name),
    phone = IF(phone IS NULL OR phone = '', VALUES(phone), phone),
    email = IF(email IS NULL OR email = '', VALUES(email), email),
    raw_text = IF(raw_text IS NULL OR char_length(raw_text) < 100, VALUES(raw_text), raw_text),
    collected_at = VALUES(collected_at),
    parsed_json = JSON_MERGE_PATCH(COALESCE(parsed_json, JSON_OBJECT()), VALUES(parsed_json)),
    missing_fields = IF(missing_fields IS NULL, VALUES(missing_fields), missing_fields)
"""


def upload_resume_files(files: list[tuple[str, bytes]], uploader: str, conn: Any) -> dict[str, Any]:
    """批量上传：逐份解析 + upsert。返回每份明细（R7 不吞错）。"""
    results: list[dict[str, Any]] = []
    inserted = updated = failed = 0
    with conn.cursor() as cur:
        for filename, data in files:
            try:
                text = extract_text(filename, data)
                if len(text) < 30:
                    raise UploadParseError("提取文本过短（<30 字符），疑似扫描件/空文件")
                fields = parse_fields(text, filename)
                fp = fingerprint_for_file(data)
                row = build_row(fields, fp, uploader, source_name=filename)
                cur.execute(UPSERT_SQL, row)
                # pymysql：1=新插入，2=命中重复后更新
                status = "inserted" if cur.rowcount == 1 else "updated"
                if status == "inserted":
                    inserted += 1
                else:
                    updated += 1
                results.append({
                    "filename": filename, "ok": True, "status": status,
                    "name": fields["name"], "phone": fields["phone"],
                    "fingerprint": fp,
                })
            except Exception as exc:
                failed += 1
                results.append({"filename": filename, "ok": False, "error": str(exc)[:200]})
    return {
        "ok": failed == 0,
        "inserted": inserted,
        "updated": updated,
        "failed": failed,
        "results": results,
    }
