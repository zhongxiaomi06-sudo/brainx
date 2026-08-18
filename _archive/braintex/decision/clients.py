"""客户中心层（L0/L2/L3）：客户档案 + 归一人审 + 客户 360 聚合 + 每日动态摘要。

纪律：
- 客户名归一「agent 自动 + 人审」（2026-08-06 用户拍板）：自动聚类只进
  review_status='pending'，工作台确认后才算 confirmed；不匹配的新信号进待审。
- 客户 360 数据全部从 job_signals/engagements/outcome_observations 聚合查询，
  不另建事实源；无数据显示 UNKNOWN（PRD §259），不得显示 0。
- digest 确认/纠正走 record_outcome（stage=digest_review），进不可变账本，
  喂养个人调权——与 S4 闭环同一套机制。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

LOCAL_TZ = timezone(timedelta(hours=8))

# 归一规则：小写 → 去括号段（括号内容另存别名）→ 去公司后缀 → 去空白标点
SUFFIX_RE = re.compile(
    r"(有限公司|有限责任公司|股份有限公司|集团|科技|智能|信息技术|网络|资本|控股|公司|ai)+$", re.I
)
PAREN_RE = re.compile(r"[（(]([^（）()]*)[)）]")
PUNCT_RE = re.compile(r"[\s\-_·.,，。'&]+")
# 群名里的客户名提取：「📌沐仞科技 x TTC客户群驾驶舱【内部群】」→ 沐仞科技
COCKPIT_NAME_RE = re.compile(r"📌\s*(.+?)\s*[x×＊*]\s*TTC", re.I)

JUNK_NAMES = {"公司", "某厂", "某公司", "ttc", ""}


def normalize_core(name: str) -> str:
    """归一核心名：PixAI/Pix AI/pixai 同核；沐仞科技/沐仞 同核。"""
    n = PAREN_RE.sub("", name or "")
    n = PUNCT_RE.sub("", n).lower()
    prev = None
    while prev != n:  # 后缀可能叠多个：xx智能科技
        prev = n
        n = SUFFIX_RE.sub("", n)
    return n


def extract_aliases(name: str) -> list[str]:
    """括号内容作为别名候选：ActionX（北京雨林时代）→ 北京雨林时代。"""
    return [m for m in PAREN_RE.findall(name or "") if m.strip()]


def cluster_companies(names: list[str]) -> dict[str, list[str]]:
    """按归一核心聚类。contain 合并仅当短核 ≥2 字符且非垃圾名，防「公司」乱并。"""
    clusters: dict[str, list[str]] = {}
    cores: list[str] = []
    for raw in names:
        core = normalize_core(raw)
        if core in JUNK_NAMES:
            continue
        hit = None
        for existing in cores:
            if core == existing:
                hit = existing
                break
            if len(core) >= 2 and len(existing) >= 2 and (core in existing or existing in core):
                hit = existing  #  containment：稳准 ⊂ 稳准智能
                break
        if hit is None:
            cores.append(core)
            clusters[core] = [raw]
        else:
            if raw not in clusters[hit]:
                clusters[hit].append(raw)
    return clusters


def client_id_for(core: str) -> str:
    return hashlib.md5(f"client|{core}".encode("utf-8")).hexdigest()[:24]


def canonical_of(variants: list[str]) -> str:
    """规范名取信息量最大的变体（最长优先，去括号后仍最长）。"""
    return max(variants, key=lambda v: (len(PAREN_RE.sub("", v)), len(v)))


# ── schema ─────────────────────────────────────────────────────
CLIENTS_DDL = """
CREATE TABLE IF NOT EXISTS clients (
    client_id VARCHAR(32) PRIMARY KEY,
    core VARCHAR(128) NOT NULL,
    canonical_name VARCHAR(128) NOT NULL,
    aliases_json JSON NOT NULL,
    cockpit_chat_id VARCHAR(64) DEFAULT '',
    owner_consultant VARCHAR(64) DEFAULT '',
    tier VARCHAR(16) DEFAULT '',
    review_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(64) DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_core (core)
)
"""

DIGEST_DDL = """
CREATE TABLE IF NOT EXISTS client_digest (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(32) NOT NULL,
    digest_date DATE NOT NULL,
    summary TEXT,
    changes_json JSON,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    corrected_text TEXT,
    reviewed_by VARCHAR(64) DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_client_date (client_id, digest_date)
)
"""


def ensure_client_schema(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute(CLIENTS_DDL)
        cur.execute(DIGEST_DDL)


# ── L0：初始化/增量归一 ─────────────────────────────────────────
def sync_clients_from_signals(conn: Any, cockpit_chats: list[dict[str, str]] | None = None) -> dict[str, int]:
    """从 job_signals 的 company 聚类生成/更新客户档案（全部 pending，等人审）。

    cockpit_chats: [{"chat_id","name"}]，群名命中「📌XX x TTC」则挂到对应客户。
    """
    ensure_client_schema(conn)
    now = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S")
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT company FROM job_signals WHERE company IS NOT NULL AND company != ''")
        names = [r[0] if not isinstance(r, dict) else r["company"] for r in cur.fetchall()]
        clusters = cluster_companies(names)

        # 驾驶舱群 → 客户映射
        chat_map: dict[str, str] = {}  # core -> chat_id
        for ch in cockpit_chats or []:
            m = COCKPIT_NAME_RE.search(ch.get("name") or "")
            if m:
                chat_map.setdefault(normalize_core(m.group(1)), ch.get("chat_id") or "")

        inserted = updated = 0
        for core, variants in clusters.items():
            cid = client_id_for(core)
            aliases = sorted(set(variants) | set(a for v in variants for a in extract_aliases(v)))
            canonical = canonical_of(variants)
            chat_id = chat_map.get(core, "")
            cur.execute(
                """
                INSERT INTO clients
                    (client_id, core, canonical_name, aliases_json, cockpit_chat_id,
                     review_status, created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,'pending',%s,%s)
                ON DUPLICATE KEY UPDATE
                    aliases_json = VALUES(aliases_json),
                    canonical_name = IF(review_status='confirmed', canonical_name, VALUES(canonical_name)),
                    cockpit_chat_id = IF(cockpit_chat_id='', VALUES(cockpit_chat_id), cockpit_chat_id),
                    updated_at = VALUES(updated_at)
                """,
                (cid, core, canonical, json.dumps(aliases, ensure_ascii=False), chat_id, now, now),
            )
            if cur.rowcount == 1:
                inserted += 1
            else:
                updated += 1
    return {"clusters": len(clusters), "inserted": inserted, "updated": updated,
            "cockpit_mapped": len(chat_map)}


def review_client(conn: Any, client_id: str, action: str, actor: str,
                  canonical_name: str = "", merge_into: str = "") -> dict[str, Any]:
    """人审：confirm（确认归一）/ rename（改规范名）/ merge（并入别的客户）。"""
    now = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S")
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM clients WHERE client_id=%s", (client_id,))
        row = cur.fetchone()
        if not row:
            return {"ok": False, "error": "client_not_found"}
        get = (lambda k: row.get(k)) if isinstance(row, dict) else None
        if get is None:  # tuple cursor
            cur.execute("SHOW COLUMNS FROM clients")
            cols = [c[0] for c in cur.fetchall()]
            d = dict(zip(cols, row))
            get = d.get
        if action == "confirm":
            cur.execute(
                "UPDATE clients SET review_status='confirmed', reviewed_by=%s, "
                "canonical_name=%s, updated_at=%s WHERE client_id=%s",
                (actor, canonical_name or get("canonical_name"), now, client_id),
            )
        elif action == "rename":
            if not canonical_name:
                return {"ok": False, "error": "rename 需要 canonical_name"}
            cur.execute(
                "UPDATE clients SET canonical_name=%s, review_status='confirmed', "
                "reviewed_by=%s, updated_at=%s WHERE client_id=%s",
                (canonical_name, actor, now, client_id),
            )
        elif action == "merge":
            if not merge_into:
                return {"ok": False, "error": "merge 需要 merge_into"}
            cur.execute("SELECT aliases_json FROM clients WHERE client_id=%s", (merge_into,))
            tgt = cur.fetchone()
            if not tgt:
                return {"ok": False, "error": "merge_target_not_found"}
            tgt_aliases = (tgt.get("aliases_json") if isinstance(tgt, dict) else tgt[0]) or "[]"
            merged = sorted(set(json.loads(tgt_aliases)) | set(json.loads(get("aliases_json") or "[]"))
                            | {get("canonical_name")})
            cur.execute("UPDATE clients SET aliases_json=%s, updated_at=%s WHERE client_id=%s",
                        (json.dumps(merged, ensure_ascii=False), now, merge_into))
            cur.execute("DELETE FROM clients WHERE client_id=%s", (client_id,))
        else:
            return {"ok": False, "error": f"unknown action: {action}"}
    return {"ok": True, "action": action, "client_id": client_id}


# ── L2：客户 360 聚合 ─────────────────────────────────────────
def _rows(cur: Any) -> list[dict[str, Any]]:
    cols = [c[0] for c in (cur.description or [])]
    out = []
    for r in cur.fetchall() or []:
        out.append(dict(r) if isinstance(r, dict) else dict(zip(cols, r)))
    return out


def list_clients(conn: Any, include_pending: bool = True) -> list[dict[str, Any]]:
    ensure_client_schema(conn)
    where = "" if include_pending else "WHERE c.review_status = 'confirmed'"
    sql = f"""
        SELECT c.client_id, c.canonical_name, c.aliases_json, c.cockpit_chat_id,
               c.owner_consultant, c.review_status,
               COUNT(s.fingerprint) AS signal_count,
               SUM(s.signal_type='heating') AS heating,
               SUM(s.signal_type='new') AS new_cnt,
               MAX(s.last_seen_at) AS last_seen
        FROM clients c
        LEFT JOIN job_signals s
          ON s.company IS NOT NULL AND JSON_CONTAINS(c.aliases_json, JSON_QUOTE(s.company), '$')
        {where}
        GROUP BY c.client_id, c.canonical_name, c.aliases_json, c.cockpit_chat_id,
                 c.owner_consultant, c.review_status
        ORDER BY heating DESC, last_seen DESC
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        rows = _rows(cur)
    for r in rows:
        r["aliases"] = json.loads(r.pop("aliases_json") or "[]")
        r["last_seen"] = str(r.get("last_seen") or "UNKNOWN")
    return rows


def client_detail(conn: Any, client_id: str) -> dict[str, Any] | None:
    ensure_client_schema(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM clients WHERE client_id=%s", (client_id,))
        rows = _rows(cur)
        if not rows:
            return None
        client = rows[0]
        aliases = json.loads(client.get("aliases_json") or "[]")
        client["aliases"] = aliases
        cur.execute(
            """
            SELECT fingerprint, job_title, company, signal_type, excerpt,
                   first_seen_at, last_seen_at
            FROM job_signals
            WHERE company IS NOT NULL AND JSON_CONTAINS(%s, JSON_QUOTE(company), '$')
            ORDER BY last_seen_at DESC LIMIT 50
            """,
            (json.dumps(aliases, ensure_ascii=False),),
        )
        signals = _rows(cur)
        fps = [s["fingerprint"] for s in signals]
        engagements: list[dict[str, Any]] = []
        outcomes: list[dict[str, Any]] = []
        if fps:
            marks = ",".join(["%s"] * len(fps))
            cur.execute(
                f"SELECT consultant_id, opportunity_id, state, last_action_at "
                f"FROM engagements WHERE opportunity_id IN ({marks})", fps)
            engagements = _rows(cur)
            cur.execute(
                f"SELECT consultant_id, stage, value_json, observed_at "
                f"FROM outcome_observations WHERE opportunity_id IN ({marks}) "
                f"ORDER BY observed_at DESC LIMIT 50", fps)
            outcomes = _rows(cur)
        cur.execute(
            "SELECT digest_date, summary, changes_json, status, corrected_text, reviewed_by "
            "FROM client_digest WHERE client_id=%s ORDER BY digest_date DESC LIMIT 14",
            (client_id,),
        )
        digests = _rows(cur)
    for s in signals:
        s["first_seen_at"] = str(s.get("first_seen_at") or "")
        s["last_seen_at"] = str(s.get("last_seen_at") or "")
    for e in engagements:
        e["last_action_at"] = str(e.get("last_action_at") or "")
    for o in outcomes:
        o["observed_at"] = str(o.get("observed_at") or "")
    for d in digests:
        d["digest_date"] = str(d.get("digest_date") or "")
    return {"client": client, "signals": signals, "engagements": engagements,
            "outcomes": outcomes, "digests": digests}


# ── L3：每日动态摘要（规则模板 v1，LLM 留接口） ──────────────────
def generate_digest(conn: Any, client_id: str, day: str | None = None) -> dict[str, Any]:
    """按最近 24h 信号生成动态摘要；幂等 upsert（同 client+date 覆盖）。"""
    ensure_client_schema(conn)
    day = day or datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    detail = client_detail(conn, client_id)
    if not detail:
        return {"ok": False, "error": "client_not_found"}
    signals = detail["signals"]
    now = datetime.now(LOCAL_TZ)
    cutoff = now - timedelta(hours=24)

    def _seen(s: dict[str, Any], key: str) -> datetime | None:
        try:
            return datetime.strptime(str(s.get(key) or "")[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=LOCAL_TZ)
        except ValueError:
            return None

    new_jobs = [s for s in signals if (_seen(s, "first_seen_at") or now - timedelta(days=365)) >= cutoff]
    heating = [s for s in signals if s.get("signal_type") == "heating"]
    closed = [s for s in signals if s.get("signal_type") == "closed"
              and (_seen(s, "last_seen_at") or now) >= cutoff]
    cooling = [s for s in signals if s.get("signal_type") == "cooling"]

    name = detail["client"]["canonical_name"]
    parts: list[str] = []
    if new_jobs:
        parts.append(f"新增 {len(new_jobs)} 个岗位信号（{'、'.join((s.get('job_title') or '未识别岗位') for s in new_jobs[:3])}）")
    if heating:
        parts.append(f"{len(heating)} 个岗位升温中")
    if closed:
        parts.append(f"{len(closed)} 个岗位关闭（{'、'.join((s.get('job_title') or '?') for s in closed[:3])}）")
    if cooling:
        parts.append(f"{len(cooling)} 个岗位降温")
    summary = f"{name}：" + "；".join(parts) if parts else f"{name}：近 24h 无新动态"
    changes = {
        "new_jobs": [{"title": s.get("job_title"), "fingerprint": s.get("fingerprint")} for s in new_jobs],
        "heating": len(heating), "closed": len(closed), "cooling": len(cooling),
        "active_signals": len(signals),
    }
    now_s = now.strftime("%Y-%m-%d %H:%M:%S")
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO client_digest (client_id, digest_date, summary, changes_json, status, created_at, updated_at)
            VALUES (%s,%s,%s,%s,'pending',%s,%s)
            ON DUPLICATE KEY UPDATE summary=VALUES(summary), changes_json=VALUES(changes_json),
                status=IF(status='confirmed', status, 'pending'), updated_at=VALUES(updated_at)
            """,
            (client_id, day, summary, json.dumps(changes, ensure_ascii=False), now_s, now_s),
        )
    return {"ok": True, "client_id": client_id, "date": day, "summary": summary, "changes": changes}
