import { useState, useEffect } from "react";
import { AlertTriangle, BellRing, ChevronRight, CircleUserRound, Clock3, Send, ShieldCheck, X } from "lucide-react";
import { brainxFetch, type BackendConsultants } from "./brainx-api";
import type { AuthStatus, EngagementCommand, Notification, SyncStatus } from "./decision-demo";
import type { DecisionJob } from "./workbench-model";
import { DrawerSection, FilterSelect, type FilterSelectOption } from "./workbench-controls";

function SyncPanel({
  sync,
  onSync,
  onSetSync,
  notify,
  mode,
}: {
  sync: SyncStatus;
  onSync: () => void;
  onSetSync: (sync: SyncStatus) => void;
  notify: (text: string) => void;
  mode: "connecting" | "connected" | "offline";
}) {
  const setDemo = (state: SyncStatus["state"]): void => {
    onSetSync({
      ...sync,
      state,
      errors: state === "ERROR" ? ["飞书消息源超时"] : state === "INCOMPLETE" ? ["职位事实未完整返回"] : [],
    });
    notify(state === "INCOMPLETE" ? "已切换为同步不完整演示状态" : "已切换为同步失败演示状态");
  };
  return (
    <>
      <div className="panel-heading">
        <ShieldCheck />
        <div>
          <h1>同步状态</h1>
          <p>当前推荐只使用完整快照</p>
        </div>
      </div>
      <DrawerSection title="当前快照">
        <dl className="facts">
          <div>
            <dt>状态</dt>
            <dd>
              {sync.state === "READY"
                ? "已同步"
                : sync.state === "RUNNING"
                  ? "同步中"
                  : sync.state === "INCOMPLETE"
                    ? "本次同步不完整"
                    : sync.state === "AUTH_EXPIRED"
                      ? "飞书授权已过期"
                      : sync.state === "ERROR"
                        ? "同步失败"
                        : "尚未同步"}
            </dd>
          </div>
          <div>
            <dt>读取进度</dt>
            <dd>
              {sync.rowsRead ?? 0} / {sync.rowsExpected ?? "—"}
            </dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{sync.updatedAt || "—"}</dd>
          </div>
          {sync.errors && sync.errors.length > 0 && (
            <div>
              <dt>错误</dt>
              <dd className="unknown">{sync.errors[0]}</dd>
            </div>
          )}
        </dl>
      </DrawerSection>
      <div className="drawer-actions">
        <button onClick={onSync}>
          <span>
            <b>重新同步</b>
            <small>{mode === "connected" ? "拉取 fixture 快照并生成新推荐" : "生成新的完整推荐快照"}</small>
          </span>
          <ChevronRight />
        </button>
        {mode !== "connected" && (
          <>
            <button onClick={() => setDemo("INCOMPLETE")}>
              <span>
                <b>模拟同步不完整</b>
                <small>验证推荐阻断界面</small>
              </span>
              <AlertTriangle />
            </button>
            <button onClick={() => setDemo("ERROR")}>
              <span>
                <b>模拟同步失败</b>
                <small>验证异常与恢复提示</small>
              </span>
              <X />
            </button>
          </>
        )}
      </div>
      <p className="panel-caption">
        {mode === "connected"
          ? "已连接 Brain X 后端；状态来自 sync_runs，重新同步会触发 fixture 同步并冻结新推荐。"
          : "当前为前端演示。后端接入后，这里映射 sync_runs 与推荐生成状态。"}
      </p>
    </>
  );
}

function IdentityPanel({
  auth,
  onAuth,
  notify,
  mode,
}: {
  auth: AuthStatus;
  onAuth: (auth: AuthStatus) => void;
  notify: (text: string) => void;
  mode: "connecting" | "connected" | "offline";
}) {
  const [consultants, setConsultants] = useState<{ consultant_id: string; display_name: string }[] | null>(
    null,
  );
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  useEffect(() => {
    brainxFetch<BackendConsultants>("/api/v1/consultants")
      .then((d) => setConsultants(d.items || []))
      .catch(() => setConsultants([]));
  }, []);
  const devLogin = (consultantId: string) =>
    void (async () => {
      setLoginBusy(consultantId);
      try {
        await brainxFetch<null>("/api/v1/session", { method: "POST", body: { consultant_id: consultantId } });
        notify("已登录 Brain X，正在加载后端快照…");
        window.setTimeout(() => window.location.reload(), 600);
      } catch (error) {
        notify(`登录失败：${error instanceof Error ? error.message : "后端未响应"}`);
        setLoginBusy(null);
      }
    })();
  const logout = () =>
    void (async () => {
      try {
        await brainxFetch<null>("/api/v1/session", { method: "DELETE" });
      } catch {}
      notify("已退出 Brain X 会话");
      window.setTimeout(() => window.location.reload(), 400);
    })();
  return (
    <>
      <div className="panel-heading">
        <CircleUserRound />
        <div>
          <h1>{auth.consultant}</h1>
          <p>{mode === "connected" ? "Brain X 顾问会话与数据授权" : "本地演示身份与后端登录"}</p>
        </div>
      </div>
      <DrawerSection title="账户状态">
        <dl className="facts">
          <div>
            <dt>登录状态</dt>
            <dd>
              {mode === "connected"
                ? "Brain X 已登录"
                : mode === "connecting"
                  ? "正在探测后端…"
                  : "演示模式（未连接后端）"}
            </dd>
          </div>
          <div>
            <dt>飞书授权</dt>
            <dd className={auth.needsReauth ? "unknown" : ""}>
              {mode === "connected" ? (auth.needsReauth ? "已过期" : "正常") : "—"}
            </dd>
          </div>
        </dl>
      </DrawerSection>
      {mode === "connected" ? (
        <div className="drawer-actions">
          <button onClick={logout}>
            <span>
              <b>退出登录</b>
              <small>清除 Brain X 会话并回到演示模式</small>
            </span>
            <ChevronRight />
          </button>
        </div>
      ) : (
        <>
          <DrawerSection title="飞书扫码登录（正式入口）">
            <p className="panel-caption">
              跳转飞书统一授权页，用你自己的飞书账号扫码授权。需在顾问花名册内，否则会被拒绝。
            </p>
            <div className="drawer-actions">
              <button
                onClick={() => {
                  window.location.href = "/api/v1/oauth/authorize";
                }}
              >
                <span>
                  <b>飞书扫码登录</b>
                  <small>跳转飞书授权页 · 登录 Brain X 工作台</small>
                </span>
                <ChevronRight />
              </button>
            </div>
          </DrawerSection>
          <DrawerSection title="登录 Brain X 后端（开发后门）">
            <p className="panel-caption">后端需以 BRAINX_DEV_AUTH=1 启动；正式环境请使用飞书授权登录。</p>
            <div className="drawer-actions">
              {consultants === null ? (
                <p className="muted">正在读取顾问花名册…</p>
              ) : consultants.length ? (
                consultants.map((c) => (
                  <button
                    key={c.consultant_id}
                    onClick={() => devLogin(c.consultant_id)}
                    disabled={loginBusy !== null}
                  >
                    <span>
                      <b>{loginBusy === c.consultant_id ? "登录中…" : c.display_name}</b>
                      <small>以该顾问身份进入 Brain X 工作台</small>
                    </span>
                    {loginBusy === c.consultant_id ? <Clock3 /> : <ChevronRight />}
                  </button>
                ))
              ) : (
                <p className="muted">后端不可达或花名册为空。</p>
              )}
            </div>
          </DrawerSection>
          <DrawerSection title="演示状态">
            <div className="drawer-actions">
              <button
                onClick={() => {
                  onAuth({ ...auth, needsReauth: !auth.needsReauth, authorized: auth.needsReauth });
                  notify(auth.needsReauth ? "已恢复授权演示状态" : "已切换为授权过期演示状态");
                }}
              >
                <span>
                  <b>{auth.needsReauth ? "恢复授权状态" : "模拟授权过期"}</b>
                  <small>用于验证后端授权恢复入口</small>
                </span>
                <ShieldCheck />
              </button>
              <button onClick={() => notify("已退出演示会话；刷新页面将恢复本地演示身份")}>
                <span>
                  <b>退出演示</b>
                  <small>不影响任何外部账号</small>
                </span>
                <ChevronRight />
              </button>
            </div>
          </DrawerSection>
        </>
      )}
    </>
  );
}

function NotificationPanel({
  items,
  onOpen,
  notify,
}: {
  items: Notification[];
  onOpen: (item: Notification) => void;
  notify: (text: string) => void;
}) {
  return (
    <>
      <div className="panel-heading">
        <BellRing />
        <div>
          <h1>今日提醒</h1>
          <p>同步、项目跟进与每日推荐摘要</p>
        </div>
      </div>
      <div className="notification-list">
        {items.map((item) => (
          <button key={item.id} className={item.read ? "read" : ""} onClick={() => onOpen(item)}>
            <i />
            <span>
              <b>{item.title}</b>
              <small>{item.detail}</small>
            </span>
            <ChevronRight />
          </button>
        ))}
      </div>
      <DrawerSection title="推送预览">
        <div className="push-preview">
          <b>今日职位判断</b>
          <span>Top 3 已生成 · 1 个项目待处理</span>
        </div>
        <button className="btn" onClick={() => notify("已模拟发送到 Felix 的飞书提醒")}>
          <Send />
          模拟发送
        </button>
        <p className="panel-caption">仅展示推送内容，不会发送到外部系统。</p>
      </DrawerSection>
    </>
  );
}

function CommandConfirm({
  pending,
  reasons,
  onClose,
  onConfirm,
}: {
  pending: { job: DecisionJob; command: EngagementCommand };
  reasons: string[];
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const list =
    reasons && reasons.length
      ? reasons
      : ["无资源", "不符合方向", "客户/职位质量不足", "当前没精力", "已有其他顾问推进", "信息不完整", "其他"];
  const [reason, setReason] = useState(list[0]);
  const dismiss = pending.command === "DISMISS";
  const reasonOptions: FilterSelectOption[] = list.map((value) => ({ value, label: value }));
  return (
    <div className="command-mask" role="presentation">
      <section className="command-modal" role="dialog" aria-modal="true" aria-label="确认项目操作">
        <h2>{dismiss ? "暂不考虑这个职位？" : "确认开始跟进？"}</h2>
        <p>{dismiss ? "选择原因后会记录到决策轨迹。" : "开始跟进前需要确认目标、第一行动和截止时间。"}</p>
        {dismiss && (
          <FilterSelect
            value={reason}
            onChange={setReason}
            ariaLabel="暂不考虑原因"
            options={reasonOptions}
          />
        )}
        <div className="command-modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onConfirm(dismiss ? reason : undefined)}>
            {dismiss ? "记录原因" : "确认开始跟进"}
          </button>
        </div>
      </section>
    </div>
  );
}


export { SyncPanel, IdentityPanel, NotificationPanel, CommandConfirm };
