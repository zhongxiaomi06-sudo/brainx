"use client";

import { AlertTriangle, CheckCircle2, Clock3, DatabaseBackup } from "lucide-react";
import { normalizeOperationsDashboard, type MetricCost, type OperationsDashboardModel } from "./operations-dashboard-model";
import "./operations-dashboard.css";

const number = (value: number | null) => value == null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
const percent = (value: number | null) => value == null ? "样本不足" : `${(value * 100).toFixed(1)}%`;
const time = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
const cost = (value: number | null) => value == null ? "未知" : `${(value / 1_000_000).toFixed(4)} USD`;

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <article className="ops-metric"><small>{label}</small><b>{value}</b>{note && <span>{note}</span>}</article>;
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = max ? Math.max(value ? 4 : 0, Math.round(value / max * 100)) : 0;
  return <div className="ops-bar"><span>{label}</span><i><em style={{ width: `${width}%` }} /></i><b>{value}</b></div>;
}

function CostColumn({ title, data }: { title: string; data: MetricCost }) {
  return <section className="ops-cost-column"><header><b>{title}</b><span>{data.calls} 次调用</span></header><dl>
    <div><dt>已知用量</dt><dd>{data.known_calls} / {data.calls}</dd></div>
    <div><dt>Token</dt><dd>{number(data.total_tokens)}</dd></div>
    <div><dt>估算成本</dt><dd>{cost(data.estimated_cost_micros)}</dd></div>
    <div><dt>P95 延迟</dt><dd>{data.p95_latency_ms == null ? "未知" : `${data.p95_latency_ms} ms`}</dd></div>
    <div><dt>失败调用</dt><dd>{data.failed_calls}</dd></div>
  </dl></section>;
}

export function OperationsDashboard({ data, loading = false }: {
  data: Partial<OperationsDashboardModel>; loading?: boolean;
}) {
  if (loading) return <div className="operations-dashboard" aria-busy="true" aria-label="运营看板加载中">
    <section className="ops-loading"><Clock3 /><div><b>正在加载运营投影</b><span>读取最近一次成功快照与新鲜度状态…</span></div></section>
    <section className="ops-loading-grid" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</section>
  </div>;
  const model = normalizeOperationsDashboard(data);
  const statusLabel = model.health === "READY" ? "投影正常" : model.health === "EMPTY" ? "暂无投影数据"
    : model.health === "FAILED" ? "投影失败" : model.freshness.status === "BACKLOG" ? "存在积压" : "数据可能陈旧";
  const StatusIcon = model.health === "READY" ? CheckCircle2 : AlertTriangle;
  const funnel = [model.funnel.served, model.funnel.visible, model.funnel.accepted,
    model.funnel.interview, model.funnel.offer, model.funnel.onboard];
  const funnelMax = Math.max(...funnel, 1);
  return <div className="operations-dashboard">
    <section className={`ops-freshness ${model.health.toLowerCase()}`}>
      <StatusIcon /><div><b>{statusLabel}</b><span>口径 {model.freshness.metric_version} · checkpoint {model.freshness.checkpoint} / {model.freshness.max_sequence}</span></div>
      <div><Clock3 /><span>最后事件 {time(model.freshness.last_event_at)}<br />积压 {model.freshness.backlog}</span></div>
    </section>

    <section className="ops-metrics" aria-label="核心状态">
      <Metric label="同步完整" value={model.operations.sync.complete} note={`失败 ${model.operations.sync.failed}`} />
      <Metric label="任务积压" value={model.operations.jobs.pending + model.operations.jobs.running} note={`失败 ${model.operations.jobs.failed}`} />
      <Metric label="真实曝光决策" value={model.sample_maturity.exposed_decisions} note={`成熟度 ${percent(model.sample_maturity.rate)}`} />
      <Metric label="当前职位" value={model.capacity.current_jobs} note={`${model.capacity.fact_versions} 个事实版本`} />
      <Metric label="投递失败" value={model.operations.delivery_failed} />
    </section>

    <section className="ops-grid">
      <article className="ops-card"><header><div><h2>真实业务漏斗</h2><p>唯一决策 / 逻辑结果，不含 SHADOW</p></div></header><div className="ops-bars">
        {["已下发", "可见", "已承接", "面试", "Offer", "Onboard"].map((label, index) => <Bar key={label} label={label} value={funnel[index]} max={funnelMax} />)}
      </div><footer>SHADOW 曝光 {model.funnel.shadow_exposures} · 业务结果 {model.funnel.shadow_outcomes}</footer></article>

      <article className="ops-card"><header><div><h2>排序与证据</h2><p>LIVE 运行和 SHADOW 评估分栏</p></div></header><div className="ops-ranking-grid">
        <dl><dt>LIVE</dt><dd>发布 {model.ranking.live.published}</dd><dd>推荐项 {model.ranking.live.recommendation_items}</dd><dd>失败 {model.ranking.live.failed} · 弃权 {model.ranking.live.abstained}</dd></dl>
        <dl>
          <dt>SHADOW</dt>
          <dd>完成 {model.ranking.shadow.completed}</dd>
          <dd>Top10 重合 {percent(model.ranking.shadow.avg_top_10_overlap)}</dd>
          <dd>NDCG 差 {model.ranking.shadow.avg_ndcg_delta ?? "样本不足"}</dd>
          <dd>标注 {model.ranking.shadow.labeled_candidates} · 硬违规 {model.ranking.shadow.hard_violations}</dd>
        </dl>
      </div></article>
    </section>

    <section className="ops-card">
      <header><div><h2>Agent 成本与延迟</h2><p>未知用量保持未知，不按 0 填充</p></div></header>
      <div className="ops-cost-grid">
        <CostColumn title="LIVE" data={model.cost.live} />
        <CostColumn title="SHADOW" data={model.cost.shadow} />
      </div>
    </section>

    <section className="ops-grid">
      <article className="ops-card">
        <header><div><h2>容量增长</h2><p>按不可变职位事实版本追踪</p></div></header>
        {model.capacity.daily_growth.length ? <div className="ops-bars">
          {model.capacity.daily_growth.slice(-7).map(item => <Bar key={item.date}
            label={item.date.slice(5)} value={item.new_jobs}
            max={Math.max(...model.capacity.daily_growth.map(row => row.new_jobs), 1)} />)}
        </div> : <p className="ops-empty">当前窗口没有新增职位证据。</p>}
      </article>
      <article className="ops-card">
        <header><div><h2>备份与恢复</h2><p>只认显式登记证据</p></div><DatabaseBackup /></header>
        <dl className="ops-backup">
          <div><dt>状态</dt><dd>{model.backup.status}</dd></div>
          <div><dt>完成时间</dt><dd>{time(model.backup.completed_at)}</dd></div>
          <div><dt>大小</dt><dd>{model.backup.size_bytes == null ? "未上报" : number(model.backup.size_bytes)}</dd></div>
          <div><dt>恢复验证</dt><dd>{model.backup.restore_verified == null ? "未上报"
            : model.backup.restore_verified ? "已验证" : "未验证"}</dd></div>
        </dl>
      </article>
    </section>

    {!!model.caveats.length && <section className="ops-caveats"><AlertTriangle /><div><b>数据说明</b>{model.caveats.map(item => <p key={item}>{item}</p>)}</div></section>}
    <details className="ops-sources"><summary>查看指标来源与粒度</summary>{model.sources.map(source => <p key={source.metric}><b>{source.metric}</b> · {source.sources.join(" / ")} · {source.grain}</p>)}</details>
  </div>;
}
