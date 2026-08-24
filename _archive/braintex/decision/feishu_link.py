"""飞书连接：每人用自己的 lark-cli 登录自己的飞书账号，自动发现自己的
驾驶舱群 → 采集岗位信号 → 写入共享 RDS job_signals。

设计纪律（2026-08-06 用户拍板）：
- 身份是各机各人的 lark-cli **用户身份**（不是 bot）——各人只能读到自己在的群，
  天然做权限隔离；谁的机器谁授权，零密钥分发。
- 设备流登录（--no-wait 拿链接 + --device-code 后台轮询）适配工作台按钮：
  前端展示授权链接/二维码，后端线程等授权完成后自动跑首次同步。
- 指纹稳定：``md5(group_chat:<chat_id>:<title>:<company>)`` —— 同一岗位被多人
  采集天然幂等去重，全组数据汇进同一个共享池，方便集中实时微调。
- 归属透明：evidence_json.collected_by 记录采集人飞书名，谁贡献的信号可追溯。
- 数据不脱敏（覆盖 §14），访问控制由部署边界（本机 127.0.0.1）负责。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

LOCAL_TZ = timezone(timedelta(hours=8))

# ── 关键词与规则（与 ttc 交易系统 scripts/job_signals_collect.py 同源） ──
DEFAULT_KEYWORDS = ["增长", "投放", "商业化", "广告", "用户获取", "海外营销"]
EXTRA_JOB_KEYWORDS = ["招聘", "岗位", "职位", "HC", "急招", "内推", "JD"]
CLOSE_KEYWORDS = ["关闭", "暂停招聘", "已招到", "招到了", "冻结", "headcount 冻结", "HC冻结", "不招了"]

TITLE_SUFFIXES = (
    "经理", "总监", "负责人", "专家", "工程师", "专员", "顾问", "主管",
    "运营", "优化师", "设计师", "分析师", "产品经理", "增长负责人",
)
TITLE_PATTERNS = [
    re.compile(r"招(?:聘)?([一-龥A-Za-z]{2,20}?(?:" + "|".join(TITLE_SUFFIXES) + r"))"),
    re.compile(r"[【\[]([^【】\[\]]{2,30}?)[】\]]"),
    re.compile(r"([一-龥A-Za-z]{2,20}?(?:" + "|".join(TITLE_SUFFIXES) + r"))[的]?(?:岗位|职位|HC|headcount)", re.I),
    re.compile(r"([一-龥A-Za-z]{2,20}?(?:" + "|".join(TITLE_SUFFIXES) + r"))"),
]
COMPANY_PATTERNS = [
    re.compile(r"公司[:：]\s*([^\s，。,；;]{2,30})"),
    re.compile(r"([一-龥A-Za-z0-9]{2,20}?公司)(?:在招|急招|招聘|招|的)"),
]
TITLE_LEADING_FILLER = re.compile(r"^(?:这个|那个|一个|急招|招聘|招|我司|客户|目前|现在)+")

LOW_VALUE_PATTERNS = [
    re.compile(r"^\s*\d+\s*[\.、]?\s*$"),
    re.compile(r"^\s*(\+1|打卡|收到|好的|ok|OK|👍|🙏)\s*$"),
    re.compile(r"加入(了)?群聊|修改群名|邀请.*加入"),
]
IMG_REF = re.compile(r"!\[[^\]]*\]\([^)]*\)")
CJK = re.compile(r"[一-龥]")

# 驾驶舱拓扑：群名命中这些词即认为是信号来源群
GROUP_NAME_HIT = re.compile(r"驾驶舱|职位市场|人才市场|^(SA|SN)-")


class FeishuLinkError(RuntimeError):
    """lark-cli 子进程失败或返回错误。"""


# ── lark-cli 封装 ────────────────────────────────────────────────
def lark_cli_path() -> str | None:
    return shutil.which("lark-cli")


def run_lark(args: list[str], timeout: int = 120) -> dict[str, Any]:
    """跑 lark-cli 子命令并返回 data 段。失败抛 FeishuLinkError。"""
    exe = lark_cli_path()
    if not exe:
        raise FeishuLinkError("lark_cli_not_installed")
    env = dict(os.environ)
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    proc = subprocess.run(
        [exe, *args, "--json"],
        capture_output=True, text=True, timeout=timeout, env=env,
    )
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        raise FeishuLinkError(err[:300] or out[:300] or f"exit {proc.returncode}")
    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        # 部分命令（如 auth login --device-code）输出不是 {ok,data} 信封
        raise FeishuLinkError(f"lark-cli 输出非 JSON: {out[:200]}")
    if isinstance(payload, dict) and payload.get("ok") is False:
        raise FeishuLinkError(json.dumps(payload.get("error"), ensure_ascii=False)[:300])
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def auth_status() -> dict[str, Any]:
    """返回 {installed, configured, logged_in, user_name, open_id, expires_at}。"""
    if not lark_cli_path():
        return {"installed": False, "configured": False, "logged_in": False}
    try:
        raw = run_lark_raw(["auth", "status"])
    except FeishuLinkError as exc:
        msg = str(exc)
        return {
            "installed": True,
            "configured": "not_configured" not in msg and "not configured" not in msg,
            "logged_in": False,
            "error": msg,
        }
    user = (raw.get("identities") or {}).get("user") or {}
    # needs_refresh ≠ 未登录：access token 过期但 refresh token 有效时，
    # lark-cli 会在下次 API 调用自动续期，应视为已登录；仅 refresh 也过期才算掉线。
    status_field = user.get("status")
    token_ok = user.get("tokenStatus") in (None, "valid", "needs_refresh")
    ready = status_field in ("ready", "needs_refresh") and token_ok
    refresh_exp = user.get("refreshExpiresAt")
    if ready and refresh_exp:
        try:
            ready = datetime.fromisoformat(str(refresh_exp)) > datetime.now(LOCAL_TZ)
        except ValueError:
            pass
    return {
        "installed": True,
        "configured": True,
        "logged_in": bool(ready),
        "user_name": user.get("userName") or "",
        "open_id": user.get("openId") or "",
        "expires_at": user.get("expiresAt") or "",
    }


def provision(app_id: str, app_secret: str, brand: str = "feishu") -> dict[str, Any]:
    """初始化本机 lark-cli 的 App 凭据（同事机器一次性步骤）。

    App 凭据由发包人线下发给同事（与 RDS 密码同级），app_secret 走 stdin
    传给 lark-cli，不出现在进程参数列表里。
    """
    exe = lark_cli_path()
    if not exe:
        raise FeishuLinkError("lark_cli_not_installed")
    env = dict(os.environ)
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    proc = subprocess.run(
        [exe, "config", "init", "--app-id", app_id, "--app-secret-stdin", "--brand", brand],
        input=app_secret, capture_output=True, text=True, timeout=60, env=env,
    )
    if proc.returncode != 0:
        raise FeishuLinkError(((proc.stderr or "").strip() or (proc.stdout or "").strip())[:300])
    return auth_status()


def run_lark_raw(args: list[str], timeout: int = 60) -> dict[str, Any]:
    """跑 lark-cli 并返回整个 JSON（auth 系列命令不走 {ok,data} 信封）。"""
    exe = lark_cli_path()
    if not exe:
        raise FeishuLinkError("lark_cli_not_installed")
    env = dict(os.environ)
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    proc = subprocess.run(
        [exe, *args, "--json"],
        capture_output=True, text=True, timeout=timeout, env=env,
    )
    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        raise FeishuLinkError(((proc.stderr or "").strip() or out)[:300])
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise FeishuLinkError(f"lark-cli 输出非 JSON: {out[:200]}")


# ── 设备流登录 ───────────────────────────────────────────────────
def start_device_login(domains: str | None = None) -> dict[str, Any]:
    """发起设备授权，返回 {device_code, verification_url, expires_in}。"""
    domains = domains or os.getenv("TTC_FEISHU_LOGIN_DOMAINS", "im")
    raw = run_lark_raw(["auth", "login", "--no-wait", "--domain", domains])
    url = raw.get("verification_url") or ""
    code = raw.get("device_code") or ""
    if not url or not code:
        raise FeishuLinkError(f"设备流发起失败: {json.dumps(raw, ensure_ascii=False)[:200]}")
    return {
        "device_code": code,
        "verification_url": url,
        "expires_in": int(raw.get("expires_in") or 600),
    }


def wait_device_login(device_code: str, timeout: int = 600) -> dict[str, Any]:
    """阻塞等用户在浏览器完成授权（lark-cli 内部轮询）。返回 auth_status()。"""
    run_lark_raw(["auth", "login", "--device-code", device_code], timeout=timeout)
    return auth_status()


# ── 群发现与消息读取 ─────────────────────────────────────────────
def list_my_groups(max_pages: int = 20) -> list[dict[str, Any]]:
    """当前用户加入的全部群（chat-list 分页）。"""
    chats: list[dict[str, Any]] = []
    token: str | None = None
    for _ in range(max_pages):
        args = ["im", "+chat-list", "--page-size", "100"]
        if token:
            args += ["--page-token", token]
        data = run_lark(args)
        items = data.get("items") or data.get("chats") or []
        chats.extend(items)
        token = data.get("page_token")
        if not token or not data.get("has_more"):
            break
    return chats


def discover_signal_groups() -> list[dict[str, str]]:
    """在我加入的群里筛出信号来源群：驾驶舱 / 职位市场 / 人才市场 / SA- / SN-。"""
    groups = []
    for c in list_my_groups():
        name = c.get("name") or ""
        cid = c.get("chat_id") or ""
        if cid and GROUP_NAME_HIT.search(name):
            groups.append({"chat_id": cid, "name": name})
    return groups


@dataclass
class Msg:
    message_id: str
    msg_type: str
    content: str
    create_time: datetime
    sender: str

    @property
    def clean_text(self) -> str:
        return IMG_REF.sub("", self.content).strip()

    @property
    def is_substantive(self) -> bool:
        if self.msg_type == "system":
            return False
        text = self.clean_text
        if not text:
            return False
        for pat in LOW_VALUE_PATTERNS:
            if pat.search(text):
                return False
        return (len(text) >= 10 and CJK.search(text) is not None) or len(text) >= 20


def list_chat_messages(chat_id: str, since: datetime, max_pages: int = 10) -> list[Msg]:
    """读群消息历史（倒序分页，翻到早于 since 即停）。"""
    msgs: list[Msg] = []
    now = datetime.now(LOCAL_TZ)
    token: str | None = None
    for _ in range(max_pages):
        args = [
            "im", "+chat-messages-list", "--chat-id", chat_id,
            "--start", since.astimezone(LOCAL_TZ).isoformat(timespec="seconds"),
            "--end", now.astimezone(LOCAL_TZ).isoformat(timespec="seconds"),
            "--page-size", "50", "--no-reactions", "--order", "desc",
        ]
        if token:
            args += ["--page-token", token]
        data = run_lark(args)
        for m in data.get("messages", []):
            ts = _parse_msg_time(m.get("create_time"))
            if ts is None:
                continue
            sender = (m.get("sender") or {}).get("name") or "unknown"
            msgs.append(Msg(
                message_id=m.get("message_id", ""),
                msg_type=m.get("msg_type", ""),
                content=m.get("content") or "",
                create_time=ts,
                sender=sender,
            ))
        token = data.get("page_token")
        if not token or not data.get("has_more"):
            break
    return msgs


def _parse_msg_time(raw: Any) -> datetime | None:
    if raw is None:
        return None
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=LOCAL_TZ)
        except ValueError:
            continue
    try:  # 毫秒时间戳兜底
        return datetime.fromtimestamp(int(text) / 1000, tz=LOCAL_TZ)
    except (ValueError, OSError):
        return None


# ── 岗位信号抽取 ─────────────────────────────────────────────────
@dataclass
class JobCluster:
    chat_id: str
    chat_name: str = ""
    title: str | None = None
    company: str | None = None
    keywords: set[str] = field(default_factory=set)
    messages: list[Msg] = field(default_factory=list)

    def fingerprint(self) -> str:
        raw = f"group_chat:{self.chat_id}:{(self.title or '').lower()}:{(self.company or '').lower()}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def classify(self, now: datetime) -> str:
        substantive = [m for m in self.messages if m.is_substantive]
        ratio = len(substantive) / max(len(self.messages), 1)
        senders = {m.sender for m in substantive}
        last24 = [m for m in substantive if (now - m.create_time) <= timedelta(hours=24)]
        first = min(m.create_time for m in self.messages)
        last = max(m.create_time for m in self.messages)
        joined = "\n".join(m.content for m in self.messages[-5:])
        if any(k in joined for k in CLOSE_KEYWORDS):
            return "closed"
        if ratio < 0.3 or len(senders) <= 1:
            return "fake_active"
        if len(last24) >= 3:
            return "heating"
        if (now - first) <= timedelta(hours=48):
            return "new"
        if (now - last) >= timedelta(days=3):
            return "cooling"
        return "active"

    def evidence(self, now: datetime, collected_by: str = "") -> dict[str, Any]:
        substantive = [m for m in self.messages if m.is_substantive]
        times = [m.create_time for m in self.messages]
        return {
            "message_count": len(self.messages),
            "substantive_count": len(substantive),
            "distinct_senders": sorted({m.sender for m in substantive}),
            "span_hours": round((max(times) - min(times)).total_seconds() / 3600, 1),
            "last24h_substantive": sum(
                1 for m in substantive if (now - m.create_time) <= timedelta(hours=24)
            ),
            "message_ids": [m.message_id for m in self.messages[:5]],
            "chat_name": self.chat_name,
            "collected_by": collected_by,
        }

    def excerpt(self, limit: int = 600) -> str:
        parts = [f"[{m.create_time:%m-%d %H:%M}] {m.sender}: {m.clean_text}" for m in self.messages]
        return "\n".join(parts)[:limit]


def hit_keywords(text: str, keywords: list[str]) -> list[str]:
    return [k for k in keywords if k in text]


def extract_title(text: str) -> str | None:
    for pat in TITLE_PATTERNS:
        m = pat.search(text)
        if m:
            title = m.group(1).strip(" ，。:：")
            title = TITLE_LEADING_FILLER.sub("", title)
            if 2 <= len(title) <= 30:
                return title
    return None


def extract_company(text: str) -> str | None:
    for pat in COMPANY_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).strip(" ，。:：")
    return None


def cluster_signals(chat_id: str, chat_name: str, msgs: list[Msg], keywords: list[str]) -> list[JobCluster]:
    clusters: dict[str, JobCluster] = {}
    for msg in msgs:
        text = msg.clean_text
        if not text or msg.msg_type == "system":
            continue
        hits = hit_keywords(text, keywords)
        if not hits:
            continue
        title = extract_title(text)
        company = extract_company(text)
        key = (title or "(未识别岗位)").lower()
        if key not in clusters:
            clusters[key] = JobCluster(chat_id=chat_id, chat_name=chat_name, title=title, company=company)
        cl = clusters[key]
        cl.keywords.update(hits)
        cl.messages.append(msg)
        if cl.title is None and title:
            cl.title = title
        if cl.company is None and company:
            cl.company = company
    return list(clusters.values())


# ── 写库（fingerprint 幂等；多人采集天然去重） ──────────────────
UPSERT_SQL = """
INSERT INTO job_signals
    (fingerprint, source, source_ref, chat_id, job_title, company,
     keywords_json, signal_type, evidence_json, excerpt, first_seen_at, last_seen_at)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON DUPLICATE KEY UPDATE
    source_ref = VALUES(source_ref),
    company = COALESCE(VALUES(company), company),
    keywords_json = VALUES(keywords_json),
    signal_type = VALUES(signal_type),
    evidence_json = VALUES(evidence_json),
    excerpt = VALUES(excerpt),
    first_seen_at = LEAST(first_seen_at, VALUES(first_seen_at)),
    last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at))
"""


def upsert_cluster(cl: JobCluster, now: datetime, collected_by: str, conn: Any) -> str:
    signal_type = cl.classify(now)
    evidence = cl.evidence(now, collected_by=collected_by)
    times = [m.create_time for m in cl.messages]
    latest_msg = max(cl.messages, key=lambda m: m.create_time)
    row = (
        cl.fingerprint(), "group_chat", f"{cl.chat_id}+{latest_msg.message_id}", cl.chat_id,
        cl.title, cl.company,
        json.dumps(sorted(cl.keywords), ensure_ascii=False), signal_type,
        json.dumps(evidence, ensure_ascii=False), cl.excerpt(),
        min(times).strftime("%Y-%m-%d %H:%M:%S"), max(times).strftime("%Y-%m-%d %H:%M:%S"),
    )
    with conn.cursor() as cur:
        cur.execute(UPSERT_SQL, row)
    return signal_type


# ── 同步编排（含状态持久化，供工作台展示） ───────────────────────
_STATE_LOCK = threading.Lock()
_SYNC_LOCK = threading.Lock()
_state: dict[str, Any] = {"running": False, "last_result": None, "login": None}


def _state_path() -> Path:
    root = os.getenv("TTC_BRAINTEX_STATE_DIR") or str(Path.home() / ".braintex-mcp")
    try:
        Path(root).mkdir(parents=True, exist_ok=True)
        probe = Path(root) / ".probe"
        probe.touch()
        probe.unlink()
        return Path(root) / "feishu_link_state.json"
    except OSError:
        return Path("logs") / "feishu_link_state.json"


def _persist_state() -> None:
    try:
        _state_path().write_text(
            json.dumps(_state, ensure_ascii=False, default=str), encoding="utf-8"
        )
    except OSError:
        pass


def _load_state() -> None:
    try:
        raw = json.loads(_state_path().read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            _state.update({k: v for k, v in raw.items() if k in ("last_result",)})
    except (OSError, json.JSONDecodeError):
        pass


_load_state()


def link_status() -> dict[str, Any]:
    """工作台状态面板用：lark-cli 安装/登录 + 待办登录流 + 上次同步结果。"""
    status = auth_status()
    with _STATE_LOCK:
        login = _state.get("login")
        last = _state.get("last_result")
        running = _state.get("running", False)
    return {
        **status,
        "login_flow": login,
        "sync_running": running,
        "last_sync": last,
    }


def begin_login() -> dict[str, Any]:
    """点「连接飞书」：发起设备流并起后台线程等授权完成，完成后自动首次同步。"""
    flow = start_device_login()
    with _STATE_LOCK:
        _state["login"] = {
            "status": "pending",
            "verification_url": flow["verification_url"],
            "expires_in": flow["expires_in"],
            "started_at": datetime.now(LOCAL_TZ).isoformat(timespec="seconds"),
        }
    _persist_state()

    def _wait() -> None:
        try:
            who = wait_device_login(flow["device_code"], timeout=flow["expires_in"] + 60)
            if who.get("logged_in"):
                with _STATE_LOCK:
                    _state["login"] = {"status": "authorized", "user_name": who.get("user_name")}
                _persist_state()
                run_sync(trigger="login")  # 授权成功 → 自动首采
            else:
                with _STATE_LOCK:
                    _state["login"] = {"status": "failed", "error": "授权后仍未登录"}
                _persist_state()
        except Exception as exc:  # 授权超时/取消
            with _STATE_LOCK:
                _state["login"] = {"status": "failed", "error": str(exc)[:300]}
            _persist_state()

    threading.Thread(target=_wait, daemon=True, name="feishu-login-wait").start()
    return {"verification_url": flow["verification_url"], "expires_in": flow["expires_in"]}


def run_sync(trigger: str = "manual", since_days: int = 3, max_groups: int = 40) -> dict[str, Any]:
    """发现我的驾驶舱群 → 采集 → 写 RDS。已在跑则返回 running 标记。"""
    if not _SYNC_LOCK.acquire(blocking=False):
        return {"ok": False, "status": "already_running"}
    with _STATE_LOCK:
        _state["running"] = True
    started = time.monotonic()
    result: dict[str, Any] = {
        "ok": False, "trigger": trigger,
        "started_at": datetime.now(LOCAL_TZ).isoformat(timespec="seconds"),
    }
    try:
        who = auth_status()
        if not who.get("logged_in"):
            result["error"] = "飞书未登录：先点「连接飞书」"
            return result
        collector = who.get("user_name") or "unknown"
        groups = discover_signal_groups()[:max_groups]
        keywords = DEFAULT_KEYWORDS + EXTRA_JOB_KEYWORDS
        since = datetime.now(LOCAL_TZ) - timedelta(days=since_days)
        now = datetime.now(LOCAL_TZ)
        stats: dict[str, int] = {}
        errors: list[str] = []
        total = 0

        from decision import db  # 延迟导入：无 RDS 环境也能 import 本模块

        with db.get_conn() as conn:
            for g in groups:
                try:
                    msgs = list_chat_messages(g["chat_id"], since)
                except Exception as exc:
                    errors.append(f"{g['name']}: {str(exc)[:120]}")
                    continue
                for cl in cluster_signals(g["chat_id"], g["name"], msgs, keywords):
                    st = upsert_cluster(cl, now, collector, conn)
                    stats[st] = stats.get(st, 0) + 1
                    total += 1
        result.update({
            "ok": True,
            "collector": collector,
            "groups": groups,
            "group_count": len(groups),
            "signal_count": total,
            "by_type": stats,
            "errors": errors,
            "elapsed_sec": round(time.monotonic() - started, 1),
        })
        return result
    except Exception as exc:
        result["error"] = str(exc)[:300]
        return result
    finally:
        with _STATE_LOCK:
            _state["running"] = False
            _state["last_result"] = {
                k: v for k, v in result.items()
                if k in ("ok", "trigger", "collector", "group_count", "signal_count",
                         "by_type", "errors", "elapsed_sec", "error")
            }
            _state["last_result"]["finished_at"] = datetime.now(LOCAL_TZ).isoformat(timespec="seconds")
            if result.get("groups") is not None:
                _state["last_result"]["groups"] = result["groups"]
        _persist_state()


def run_sync_background(trigger: str = "auto", since_days: int = 3) -> bool:
    """后台线程跑同步；已在跑则跳过。返回是否成功启动。"""
    if _state.get("running"):
        return False

    def _run() -> None:
        run_sync(trigger=trigger, since_days=since_days)

    threading.Thread(target=_run, daemon=True, name="feishu-sync").start()
    return True


def autosync_loop(interval_sec: int, since_days: int = 2, stop: threading.Event | None = None) -> None:
    """工作台常驻自动同步：登录状态下每 interval_sec 采一轮。仅供 app 启动时调用一次。"""
    while not (stop and stop.is_set()):
        try:
            if auth_status().get("logged_in"):
                run_sync(trigger="autosync", since_days=since_days)
        except Exception:
            pass  # 自动同步永不炸主进程
        time.sleep(interval_sec)
