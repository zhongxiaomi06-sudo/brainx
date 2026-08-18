#!/usr/bin/env python3
"""飞书岗位数据 → job_signals 桥接（解「信号供给」瓶颈）。

四个飞书数据源（2026-08-05 用户指定「这个是现在的数据」）：
1. TTC驾驶舱全景图（Base Q1y5bYMiyaQVZes38GEcWt0UnDs / tblnNaXuz4O2moj5）
   ——38 家客户公司，技术/算法/产运三列共 138 个岗位条目。
2. 职位盘点·团队项目列表（Base RR5NbWHEfacz4jsRYMocy1qAnSh / tblsZBwtKIrIgtre）
   ——31 行，带「还做吗」优先级（1重点高优 / 常年招 / 新 / 无待定）。
3. 公司岗位情况-Shanon（Sheet KneNsTcWBh1WybtAzckcLl20nSb / ef4811）
   ——40 公司，AI产品/运营/UIUX/研发四列共 78 个岗位条目。
4. Felix 投放增长营销项目池（Sheet SQZFs4FG1hZvj0tyIONcoHuenuh / 0Osykp）
   ——20 行，P0-P2 优先级。

信号类型映射（与 decision.engine.ACTIVE_SIGNAL_TYPES 对齐）：
heating=高优/在招（urgency +20）｜active=常态在招｜new=新/待确认｜cooling=暂停（不推荐）。

幂等：fingerprint = md5(source|company|job_title)，重复跑只更新 last_seen_at/内容。
数据纪律：不脱敏（2026-08-05 拍板），excerpt 原文入库。

用法：
    PYTHONPATH=. ~/Downloads/ttc的交易系统/candidate-collector/.venv/bin/python \\
        scripts/sync_feishu_signals.py [--dry-run]
依赖：lark-cli 已登录（--as user 可读上述文档）、RDS_* 在 env 或 ttc .env。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# 复用 ttc .env（与 cloud_sync 同一套凭据发现）
for _candidate in (
    Path.home() / "Downloads" / "ttc的交易系统" / ".env",
    Path(__file__).resolve().parents[2] / "ttc的交易系统" / ".env",
):
    if _candidate.is_file():
        for line in _candidate.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())
        break

COCKPIT_BASE = ("Q1y5bYMiyaQVZes38GEcWt0UnDs", "tblnNaXuz4O2moj5")
INVENTORY_BASE = ("RR5NbWHEfacz4jsRYMocy1qAnSh", "tblsZBwtKIrIgtre")
SHANON_SHEET = ("KneNsTcWBh1WybtAzckcLl20nSb", "ef4811")
FELIX_SHEET = ("SQZFs4FG1hZvj0tyIONcoHuenuh", "0Osykp")

LARK_ENV = {**os.environ, "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1",
            "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1"}


def _lark(args: list[str]) -> dict:
    out = subprocess.run(["lark-cli", *args, "--as", "user", "--format", "json"],
                         capture_output=True, text=True, env=LARK_ENV, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(f"lark-cli {' '.join(args[:3])} 失败: {out.stderr[:300]}")
    payload = json.loads(out.stdout)
    if not payload.get("ok"):
        raise RuntimeError(f"lark-cli {' '.join(args[:3])} 返回错误: {str(payload)[:300]}")
    return payload["data"]


def _base_rows(base_token: str, table_id: str, limit: int = 200) -> tuple[list[str], list[list]]:
    data = _lark(["base", "+record-list", "--base-token", base_token,
                  "--table-id", table_id, "--limit", str(limit)])
    if data.get("has_more"):
        raise RuntimeError(f"{base_token}/{table_id} 超过 {limit} 行，需要分页——请扩容后再跑")
    return data["fields"], data["data"]


def _sheet_rows(token: str, sheet_id: str, range_: str) -> list[list[str]]:
    import csv
    import io
    data = _lark(["sheets", "+csv-get", "--spreadsheet-token", token,
                  "--sheet-id", sheet_id, "--range", range_])
    text = data.get("annotated_csv") or ""
    lines = [re.sub(r"^\[row=\d+\] ", "", line) for line in text.splitlines()]
    return [row for row in csv.reader(io.StringIO("\n".join(lines))) if any(c.strip() for c in row)]


def _flat(value) -> str:
    if isinstance(value, list):
        return ",".join(str(v) for v in value)
    return (value or "").strip() if isinstance(value, str) else (str(value) if value else "")


def _split_jobs(text: str) -> list[str]:
    parts = re.split(r"[、，/\n]+", text or "")
    return [p.strip() for p in parts if p.strip()]


def _fp(source: str, company: str, job: str) -> str:
    return hashlib.md5(f"{source}|{company}|{job}".encode()).hexdigest()[:32]


def collect_signals() -> list[dict]:
    signals: list[dict] = []

    # 1) 驾驶舱全景图：每行公司 × 三类岗位列 → 每岗位条目一条信号
    fields, rows = _base_rows(*COCKPIT_BASE)
    idx = {name: i for i, name in enumerate(fields)}
    for row in rows:
        company = _flat(row[idx["公司名称"]])
        if not company:
            continue
        biz = _flat(row[idx["业务方向"]])
        loc = _flat(row[idx["地点"]])
        category = _flat(row[idx["岗位分类"]])
        doc = _flat(row[idx["客户文档"]])
        signal_type = "new" if category == "待确认" else "heating"
        for col in ("技术岗", "算法岗", "产运岗"):
            for job in _split_jobs(_flat(row[idx[col]])):
                signals.append({
                    "fingerprint": _fp("feishu-cockpit", company, job),
                    "source": "feishu_cockpit",
                    "source_ref": f"{COCKPIT_BASE[0]}/{COCKPIT_BASE[1]}",
                    "job_title": job,
                    "company": company,
                    "keywords": [k for k in (biz, category, col, loc) if k],
                    "signal_type": signal_type,
                    "excerpt": f"{company}｜{biz}｜{loc}｜{col}：{job}"
                               + (f"\n客户文档：{doc}" if doc else ""),
                })

    # 2) 职位盘点：还做吗 → 信号类型；「无，待定」= cooling（不推荐）
    type_map = {"1重点高优": "heating", "有，正常招/常年招": "active",
                "新": "new", "无，待定": "cooling"}
    fields, rows = _base_rows(*INVENTORY_BASE)
    idx = {name: i for i, name in enumerate(fields)}
    for row in rows:
        company = _flat(row[idx["公司"]])
        if not company:
            continue
        positions = _flat(row[idx["职位"]])
        status = _flat(row[idx["还做吗"]])
        loc = _flat(row[idx["地点"]])
        note = _flat(row[idx["文本"]])
        ctype = _flat(row[idx["公司类型"]])
        signals.append({
            "fingerprint": _fp("feishu-inventory", company, positions),
            "source": "feishu_inventory",
            "source_ref": f"{INVENTORY_BASE[0]}/{INVENTORY_BASE[1]}",
            "job_title": positions.replace(",", " / "),
            "company": company,
            "keywords": [k for k in (ctype, loc, status) if k],
            "signal_type": type_map.get(status, "new"),
            "excerpt": f"{company}｜{ctype}｜{loc}｜{status}"
                       + (f"\n备注：{note}" if note else ""),
        })

    # 3) Shanon 公司岗位情况：四列岗位逐行拆
    rows = _sheet_rows(*SHANON_SHEET, "A1:H100")
    header = rows[0]
    for row in rows[1:]:
        row += [""] * (len(header) - len(row))
        company = row[0].strip()
        if not company:
            continue
        loc, ctype = row[1].strip(), row[2].strip()
        for col_i, col_name in ((3, "AI产品"), (4, "运营"), (5, "UIUX设计"), (6, "研发or其他")):
            for job in _split_jobs(row[col_i] if col_i < len(row) else ""):
                signals.append({
                    "fingerprint": _fp("feishu-shanon", company, job),
                    "source": "feishu_shanon",
                    "source_ref": f"{SHANON_SHEET[0]}/{SHANON_SHEET[1]}",
                    "job_title": job,
                    "company": company,
                    "keywords": [k for k in (ctype, col_name, loc) if k],
                    "signal_type": "heating",
                    "excerpt": f"{company}｜{ctype}｜{loc}｜{col_name}：{job}",
                })

    # 4) Felix 项目池：优先级 P0-P2 → 信号类型；未加入/驾驶舱推荐均可推
    prio_map = {"P0": "heating", "P1": "active", "P2": "new", "待判断": "new"}
    rows = _sheet_rows(*FELIX_SHEET, "A1:I200")
    header_i = next(i for i, r in enumerate(rows) if r and r[0] == "客户")
    for row in rows[header_i + 1:]:
        row += [""] * (9 - len(row))
        client, position, tag, prio, status = row[0].strip(), row[1].strip(), row[2].strip(), row[3].strip(), row[4].strip()
        if not client or not position:
            continue
        signals.append({
            "fingerprint": _fp("feishu-felix", client, position),
            "source": "feishu_felix",
            "source_ref": f"{FELIX_SHEET[0]}/{FELIX_SHEET[1]}",
            "job_title": position,
            "company": client,
            "keywords": [k for k in (tag, prio, status) if k],
            "signal_type": prio_map.get(prio, "new"),
            "excerpt": f"{client}｜{tag}｜{prio}｜{status}"
                       + (f"\n岗位核心：{row[6].strip()}" if len(row) > 6 and row[6].strip() else "")
                       + (f"\n下一步：{row[7].strip()}" if len(row) > 7 and row[7].strip() else ""),
        })
    return signals


def upsert_signals(signals: list[dict], *, dry_run: bool = False) -> dict:
    import pymysql

    now = datetime.now().replace(microsecond=0)
    stats = {"total": len(signals), "inserted": 0, "updated": 0, "by_type": {}}
    for s in signals:
        stats["by_type"][s["signal_type"]] = stats["by_type"].get(s["signal_type"], 0) + 1
    if dry_run:
        return stats
    conn = pymysql.connect(
        host=os.environ["RDS_HOST"], port=int(os.environ.get("RDS_PORT", "3306")),
        user=os.environ["RDS_USER"], password=os.environ["RDS_PASSWORD"],
        database=os.environ.get("RDS_DB", "ttc_talent"), charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            for s in signals:
                cur.execute("SELECT id FROM job_signals WHERE fingerprint=%s", (s["fingerprint"],))
                exists = cur.fetchone() is not None
                cur.execute(
                    "INSERT INTO job_signals "
                    "(fingerprint, source, source_ref, job_title, company, keywords_json, "
                    "signal_type, evidence_json, excerpt, first_seen_at, last_seen_at, "
                    "created_at, updated_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON DUPLICATE KEY UPDATE job_title=VALUES(job_title), company=VALUES(company), "
                    "keywords_json=VALUES(keywords_json), signal_type=VALUES(signal_type), "
                    "excerpt=VALUES(excerpt), last_seen_at=VALUES(last_seen_at), "
                    "updated_at=VALUES(updated_at)",
                    (s["fingerprint"], s["source"], s["source_ref"], s["job_title"],
                     s["company"], json.dumps(s["keywords"], ensure_ascii=False),
                     s["signal_type"], json.dumps({"bridge": "sync_feishu_signals",
                                                   "synced_at": now.isoformat()}, ensure_ascii=False),
                     s["excerpt"], now, now, now, now),
                )
                stats["updated" if exists else "inserted"] += 1
        conn.commit()
    finally:
        conn.close()
    return stats


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    signals = collect_signals()
    by_source: dict[str, int] = {}
    for s in signals:
        by_source[s["source"]] = by_source.get(s["source"], 0) + 1
    stats = upsert_signals(signals, dry_run=dry_run)
    print(json.dumps({"dry_run": dry_run, "by_source": by_source, **stats},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
