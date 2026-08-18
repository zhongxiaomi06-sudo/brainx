"""Build and optionally send Feishu recommendation cards."""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote

from decision import db
from decision.security import make_token
from decision.signal_scorer import DIMENSION_REGISTRY

try:
    from ttc_daemon.notifications.feishu_bot import _enabled, _send_card, _webhook_url
except ImportError:  # running with ttc_daemon itself on PYTHONPATH
    from notifications.feishu_bot import _enabled, _send_card, _webhook_url

_DISPLAY_NAMES = {name: meta["desc"] for name, meta in DIMENSION_REGISTRY.items()}


def _json(value: Any, default: Any) -> Any:
    if isinstance(value, (str, bytes, bytearray)):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return default
    return value if value is not None else default


def _iso(value: Any) -> str:
    return value.isoformat()[:10] if hasattr(value, "isoformat") else str(value)[:10]


def _dimensions(reasons: Any) -> list[dict[str, Any]]:
    if isinstance(reasons, dict):
        return list(reasons.get("dimensions") or [])
    return []


def build_card(rec: dict[str, Any], base_url: str, index: int, total: int) -> dict[str, Any]:
    rec_id = int(rec["id"])
    token = make_token(rec_id, rec["rec_date"])
    base = base_url.rstrip("/")
    title = f"📋 今日选品推荐 {index}/{total} · {rec.get('job_title') or '未命名岗位'} @ {rec.get('company') or '未知公司'} · {float(rec.get('total_score', 0)):.1f}分"
    reasons = _json(rec.get("reasons_json"), {})
    trial = _json(rec.get("trial_candidates_json"), [])
    reason_lines = []
    for item in _dimensions(reasons):
        name = _DISPLAY_NAMES.get(item.get("name", ""), item.get("name", ""))
        reason_lines.append(
            f"{name} {float(item.get('score', 0)):.1f}×{float(item.get('weight', 0)):.2f}="
            f"{float(item.get('weighted', 0)):.1f} · {item.get('reason', '')}"
        )
    trial_lines = []
    for pos, candidate in enumerate(trial, 1):
        evidence = "；".join(candidate.get("evidence") or []) or "暂无证据"
        trial_lines.append(f"{pos}. {candidate.get('name') or '未知'} {float(candidate.get('score', 0)):.1f}分 · {evidence}")
    if not trial_lines:
        trial_lines = ["暂无可试单人选"]
    elements: list[dict[str, Any]] = []
    if index == 1 and total < 3:
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": f"今日有效岗位信号仅 {total} 条，样本不足 3 条，请谨慎决策。"}})
    elements.extend([
        {"tag": "div", "text": {"tag": "lark_md", "content": "**决策指示**\n" + "\n".join(reason_lines)}},
        {"tag": "hr"},
        {"tag": "div", "text": {"tag": "lark_md", "content": "**试单人选**\n" + "\n".join(trial_lines)}},
        {"tag": "action", "actions": [
            {"tag": "button", "text": {"tag": "plain_text", "content": "✅ 采纳去做"}, "type": "primary", "url": f"{base}/static/apps/brianx/confirm.html?token={quote(token)}&action=adopt"},
            {"tag": "button", "text": {"tag": "plain_text", "content": "❌ 忽略"}, "type": "danger", "url": f"{base}/static/apps/brianx/confirm.html?token={quote(token)}&action=ignore"},
        ]},
        {"tag": "note", "elements": [{"tag": "plain_text", "content": f"调权重: {base}/static/apps/brianx/weights.html ｜ 面板: {base}/static/apps/brianx/index.html"}]},
    ])
    return {"msg_type": "interactive", "card": {"header": {"template": "blue", "title": {"tag": "plain_text", "content": title}}, "elements": elements}}


def _row_dict(row: Any, columns: list[str] | None = None) -> dict[str, Any]:
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, "keys"):
        return {key: row[key] for key in row.keys()}
    return dict(zip(columns or [], row))


def _yesterday_summary(cur: Any) -> dict[str, Any]:
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    cur.execute("SELECT sent_at, status FROM recommendations WHERE rec_date=%s", (yesterday,))
    rows = cur.fetchall() or []
    pushed = responded = adopted = ignored = 0
    for row in rows:
        item = _row_dict(row, ["sent_at", "status"])
        if item.get("sent_at") is not None:
            pushed += 1
        if item.get("status") in {"adopted", "ignored"}:
            responded += 1
        adopted += item.get("status") == "adopted"
        ignored += item.get("status") == "ignored"
    return {"pushed": pushed, "responded": responded, "adopted": adopted, "ignored": ignored}


def _summary_card(summary: dict[str, Any]) -> dict[str, Any]:
    denominator = summary["adopted"] + summary["ignored"]
    adoption = f"{summary['adopted'] / denominator:.0%}" if denominator else "暂无数据"
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    return {"msg_type": "interactive", "card": {"header": {"template": "blue", "title": {"tag": "plain_text", "content": f"📊 昨日推荐回顾 · {yesterday}"}}, "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": f"推送 {summary['pushed']} · 响应 {summary['responded']} · 采纳 {summary['adopted']} · 忽略 {summary['ignored']} · 采纳率 {adoption}"}}]}}


def push_pending(dry_run: bool = False, force: bool = False, daily: bool = False, rec_id: int | None = None) -> dict[str, int]:
    if not dry_run and (not _enabled() or _webhook_url() is None):
        print("[decision.push_card] webhook 未配置，跳过推送", file=sys.stderr)
        return {"sent": 0, "failed": 0, "skipped": 0}
    base_url = os.getenv("TTC_DECISION_BASE_URL", "")
    if not dry_run and not base_url:
        print("[decision.push_card] TTC_DECISION_BASE_URL 未配置，跳过推送", file=sys.stderr)
        return {"sent": 0, "failed": 0, "skipped": 0}
    base_url = base_url or "http://127.0.0.1:8765"
    result = {"sent": 0, "failed": 0, "skipped": 0}
    try:
        with db.get_conn() as conn:
            with conn.cursor() as cur:
                where = "rec_date=CURDATE() AND status='pending'"
                if not force:
                    where += " AND sent_at IS NULL"
                if rec_id is not None:
                    where += " AND id=%s"
                    rows_params = (rec_id,)
                else:
                    rows_params = ()
                cur.execute(f"SELECT * FROM recommendations WHERE {where} ORDER BY total_score DESC", rows_params)
                rows = cur.fetchall() or []
                columns = [item[0] for item in (getattr(cur, "description", None) or [])]
                recs = [_row_dict(row, columns) for row in rows]
                if daily:
                    try:
                        cur2 = conn.cursor()
                        try:
                            summary = _yesterday_summary(cur2)
                        finally:
                            cur2.close()
                        if dry_run:
                            print(json.dumps(_summary_card(summary), ensure_ascii=False, indent=2))
                        else:
                            try:
                                if not _send_card(_summary_card(summary)):
                                    raise RuntimeError("飞书 webhook 返回失败")
                            except Exception as exc:
                                print(f"[decision.push_card] 昨日摘要发送失败：{exc}", file=sys.stderr)
                    except Exception as exc:
                        print(f"[decision.push_card] 昨日摘要统计失败，继续推送：{exc}", file=sys.stderr)
                if not recs:
                    result["skipped"] = 1
                    return result
                for index, rec in enumerate(recs, 1):
                    try:
                        payload = build_card(rec, base_url, index, len(recs))
                        if dry_run:
                            print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
                        elif _send_card(payload):
                            cur.execute("UPDATE recommendations SET sent_at=NOW(), send_attempts=send_attempts+1, last_send_error='' WHERE id=%s", (rec["id"],))
                            conn.commit()
                        else:
                            raise RuntimeError("飞书 webhook 返回失败")
                        result["sent"] += 1
                    except Exception as exc:
                        result["failed"] += 1
                        if not dry_run:
                            cur.execute("UPDATE recommendations SET send_attempts=send_attempts+1, last_send_error=%s WHERE id=%s", (str(exc)[:200], rec["id"]))
                            conn.commit()
                        print(f"[decision.push_card] rec_id={rec.get('id')} 推送失败：{exc}", file=sys.stderr)
            if not dry_run:
                conn.commit()
        return result
    except Exception as exc:
        print(f"[decision.push_card] 查询失败：{exc}", file=sys.stderr)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Push Brian X cards")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--daily", action="store_true")
    parser.add_argument("--rec-id", type=int)
    args = parser.parse_args(argv)
    push_pending(args.dry_run, args.force, args.daily, args.rec_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
