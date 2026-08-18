"""Daily recommendation generation CLI（S2：决策引擎接线 + sync 完整性阻断 + clock 注入）。

链路（§5.1/§11 S2）：
sync 完整性检查（complete=false 阻断）→ 拉取信号/候选人（窗口用注入 clock）→
engine.decide（硬约束 + coverage 分档 + 稳定排序）→ 写 recommendations
（含 action/confidence_band/evidence_coverage/policy_version）→ 落 RECOMMENDED 事件 →
记录本 sync_run。
"""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import argparse
import hashlib
import json
import sys
import uuid
from datetime import datetime, timedelta
from typing import Any

from decision import commands, db, personalizer
from decision.engine import decide
from decision.engagement import CommandError
from decision.event_store import MysqlStore
from decision.trial_picker import pick_trial, score_pool, supply_hits


def _row_dict(row: Any, columns: list[str] | None = None) -> dict[str, Any]:
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, "keys"):
        return {key: row[key] for key in row.keys()}
    if columns:
        return dict(zip(columns, row))
    return {}


def _keywords(raw: Any) -> list[str]:
    if not raw:
        return []
    try:
        values = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    if not isinstance(values, (list, tuple)):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        clean = value.strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def normalize_jd_text(signal: dict[str, Any]) -> tuple[str, int]:
    keywords = _keywords(signal.get("keywords_json"))
    valid = [kw for kw in keywords if len(kw) >= 2]
    text = (
        f"岗位：{signal.get('job_title') or ''}\n"
        f"公司：{signal.get('company') or ''}\n"
        f"关键词：{' '.join(valid)}\n"
        f"聊天证据：{signal.get('excerpt') or ''}"
    )
    return text, len(valid)


def _fetch_rows(cur: Any, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    cur.execute(sql, params)
    rows = cur.fetchall() or []
    columns = [item[0] for item in (getattr(cur, "description", None) or [])]
    return [_row_dict(row, columns) for row in rows]


# ---------------------------------------------------------------------------
# sync_runs 完整性（§11 S2：complete=false 阻断日推）
# ---------------------------------------------------------------------------


def sync_block_reason(rows: list[dict[str, Any]]) -> str:
    """纯判定：最近一次 job_signals 同步不完整则阻断。无记录不阻断（冷启动放行）。"""
    if not rows:
        return ""
    latest = rows[0]
    if not latest.get("complete"):
        return f"job_signals 同步不完整（sync_id={latest.get('sync_id', '')}），阻断日推"
    return ""


def check_sync_guard(cur: Any, consultant: str) -> None:
    rows = _fetch_rows(
        cur,
        "SELECT sync_id, complete FROM sync_runs WHERE source='job_signals' "
        "AND consultant_id IN ('', %s) ORDER BY started_at DESC LIMIT 1",
        (consultant,),
    )
    reason = sync_block_reason(rows)
    if reason:
        raise RuntimeError(reason)


def record_sync_run(cur: Any, *, consultant: str, source: str, as_of: datetime,
                    rows_read: int, complete: bool, errors: list[str],
                    input_hash: str, started_at: datetime, completed_at: datetime | None) -> str:
    sync_id = uuid.uuid4().hex[:32]
    cur.execute(
        "INSERT INTO sync_runs "
        "(sync_id, consultant_id, source, as_of, rows_expected, rows_read, complete, "
        "errors_json, input_hash, started_at, completed_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (sync_id, consultant, source, as_of, None, rows_read, 1 if complete else 0,
         json.dumps(errors, ensure_ascii=False), input_hash, started_at, completed_at),
    )
    return sync_id


def _input_hash(signals: list[dict[str, Any]]) -> str:
    parts = sorted(f"{s.get('fingerprint', '')}|{s.get('last_seen_at', '')}" for s in signals)
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:40]


def daily_recommend(consultant: str = "", top: int = 3, dry_run: bool = False,
                    now: datetime | None = None) -> list[dict[str, Any]]:
    now = (now or datetime.now()).replace(tzinfo=None)
    started_at = now
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                check_sync_guard(cur, consultant)
                signals = _fetch_rows(
                    cur,
                    "SELECT fingerprint, job_title, company, keywords_json, excerpt, signal_type, last_seen_at "
                    "FROM job_signals WHERE last_seen_at >= %s "
                    "AND signal_type IN ('new', 'heating', 'active') "
                    "AND job_title IS NOT NULL AND job_title <> ''",
                    ((now - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S"),),
                )
                candidates = _fetch_rows(
                    cur,
                    "SELECT fingerprint, name, raw_text FROM cloud_candidates "
                    "WHERE char_length(raw_text) > 100",
                )
                weights = db.current_weights(seed=not dry_run)
                baseline = {"policy_version": f"baseline-{weights['version']}.0",
                            "weights": weights["weights"]}
                store = MysqlStore(cur)
                # 双轨调权（§6.1）：manual_override > auto_active > baseline
                resolved = personalizer.resolve(store, consultant or "", baseline)
                policy_version = resolved["policy_version"]
                blocked = commands.recommendable_fingerprints(store, consultant, now=now)

                jd_texts: dict[str, str] = {}

                def supply_fn(signal: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
                    jd_text, _ = normalize_jd_text(signal)
                    jd_texts[signal.get("fingerprint") or ""] = jd_text
                    scored = score_pool(jd_text, candidates)
                    return supply_hits(scored), pick_trial(scored)

                decision = decide(signals, resolved["weights"], supply_fn,
                                  now=now, policy_version=policy_version,
                                  blocked_fingerprints=blocked)
                results = decision["rows"][: max(0, top)]
                rec_date = now.date().isoformat()
                for row in results:
                    row.update({"rec_date": rec_date, "consultant": consultant,
                                "weight_version": weights["version"]})
                if dry_run:
                    print(json.dumps({"rows": results, "excluded": decision["excluded"],
                                      "policy_version": policy_version},
                                     ensure_ascii=False, indent=2, default=str))
                    return results
                for row in results:
                    cur.execute(
                        "INSERT INTO recommendations "
                        "(rec_date, consultant, job_signal_fingerprint, job_title, company, signal_type, "
                        "jd_text_snapshot, total_score, reasons_json, trial_candidates_json, status, "
                        "weight_version, action, confidence_band, evidence_coverage, policy_version) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                        "ON DUPLICATE KEY UPDATE total_score=VALUES(total_score), "
                        "reasons_json=VALUES(reasons_json), trial_candidates_json=VALUES(trial_candidates_json), "
                        "weight_version=VALUES(weight_version), jd_text_snapshot=VALUES(jd_text_snapshot), "
                        "action=VALUES(action), confidence_band=VALUES(confidence_band), "
                        "evidence_coverage=VALUES(evidence_coverage), policy_version=VALUES(policy_version)",
                        (
                            rec_date, consultant, row["fingerprint"], row["job_title"],
                            row["company"], row["signal_type"],
                            jd_texts.get(row["fingerprint"], ""),
                            row["total_score"], json.dumps(row["reasons"], ensure_ascii=False),
                            json.dumps(row["trial_candidates"], ensure_ascii=False), "pending",
                            weights["version"], row["action"], row["confidence_band"],
                            row["evidence_coverage"], policy_version,
                        ),
                    )
                    try:
                        commands.execute_command(
                            store, "recommend",
                            consultant_id=consultant or "unknown",
                            opportunity_id=row["fingerprint"],
                            idempotency_key=f"daily:{rec_date}:{consultant}:{row['fingerprint']}",
                            policy_version=policy_version, now=now,
                            metadata={"source": "daily_recommend"},
                        )
                    except CommandError as exc:
                        # 已 ACCEPTED/冷却期中等状态下的重推不落事件，不阻断日推
                        print(f"[decision.recommend] 事件落账跳过 {row['fingerprint']}: {exc}",
                              file=sys.stderr)
                record_sync_run(
                    cur, consultant=consultant, source="daily_recommend", as_of=now,
                    rows_read=len(signals), complete=True, errors=[],
                    input_hash=_input_hash(signals), started_at=started_at,
                    completed_at=datetime.now(),
                )
            conn.commit()
        return results
    except Exception as exc:
        print(f"[decision.recommend] 生成失败：{exc}", file=sys.stderr)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate Brian X recommendations")
    parser.add_argument("--consultant", default="")
    parser.add_argument("--top", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    daily_recommend(args.consultant, args.top, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
