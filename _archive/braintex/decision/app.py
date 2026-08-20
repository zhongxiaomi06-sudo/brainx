"""Braintex 独立运行入口：FastAPI app = 决策 API 路由 + 飞书连接 + 静态工作台。

启动：
    PYTHONPATH=. uvicorn decision.app:app --port 8766
工作台：http://127.0.0.1:8766/static/apps/brianx/index.html
飞书连接：http://127.0.0.1:8766/static/apps/brianx/feishu.html

自动同步：登录飞书后默认每 2 小时自动采集各人驾驶舱群信号入共享 RDS
（TTC_FEISHU_AUTOSYNC=0 关闭，TTC_FEISHU_SYNC_INTERVAL 改间隔秒数）。
"""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import os
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from decision.api import clients_router, feishu_router, router, upload_router

STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"

app = FastAPI(title="Braintex 决策工作台", version="2.3")
app.include_router(router)
app.include_router(feishu_router)
app.include_router(upload_router)
app.include_router(clients_router)
app.mount("/static", StaticFiles(directory=str(STATIC_ROOT)), name="static")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "braintex"}


@app.on_event("startup")
def _start_feishu_autosync() -> None:
    """常驻自动同步线程：已登录飞书则周期性采集。默认开，显式关才关。"""
    if os.getenv("TTC_FEISHU_AUTOSYNC", "1") == "0":
        return
    interval = int(os.getenv("TTC_FEISHU_SYNC_INTERVAL", "7200"))

    from decision import feishu_link

    threading.Thread(
        target=feishu_link.autosync_loop,
        kwargs={"interval_sec": interval, "since_days": 2},
        daemon=True,
        name="feishu-autosync",
    ).start()
