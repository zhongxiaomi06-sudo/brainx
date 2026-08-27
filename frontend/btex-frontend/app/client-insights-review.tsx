"use client";

import { useMemo, useState } from "react";
import { ArrowDownUp, BriefcaseBusiness, Building2, ChevronRight, Search, ShieldAlert, X } from "lucide-react";
import "./client-insights-review.css";

export type ClientFactRow = {
  company: string;
  companyType: string | null;
  jobCount: number;
  activeJobs: number;
  knownHc: number | null;
  lastActivity: string | null;
  relations: string[];
  states: string[];
};

type ClientSort = "active" | "hc" | "recent";
type ClientInsightsReviewProps = {
  clients: ClientFactRow[];
  onOpenJobs?: (company: string) => void;
};

const relationLabels: Record<string, string> = {
  MY_JOB: "本人主做",
  TEAM_SHARED: "团队共享",
  OTHER_CONSULTANT: "其他顾问主做",
};

const stateLabels: Record<string, string> = {
  OPEN: "开放",
  COOLING: "冷却",
  CLOSED: "关闭",
};

function displayDate(value: string | null) {
  return value ? String(value).slice(0, 10) : "—";
}

function FactTags({ values, labels }: { values: string[]; labels: Record<string, string> }) {
  return values.length ? <div className="client-fact-tags">{values.map(value => <span key={value}>{labels[value] || value}</span>)}</div> : <span className="client-muted">—</span>;
}

export function ClientInsightsReview({ clients, onOpenJobs }: ClientInsightsReviewProps) {
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const [sort, setSort] = useState<ClientSort>("active");
  const [selected, setSelected] = useState<ClientFactRow | null>(null);
  const visible = useMemo(() => clients
    .filter(client => !onlyActive || client.activeJobs > 0)
    .filter(client => `${client.company} ${client.companyType || ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === "hc"
      ? (b.knownHc ?? -1) - (a.knownHc ?? -1)
      : sort === "recent"
        ? String(b.lastActivity || "").localeCompare(String(a.lastActivity || ""))
        : b.activeJobs - a.activeJobs || b.jobCount - a.jobCount), [clients, onlyActive, query, sort]);
  const totals = useMemo(() => ({
    clients: clients.length,
    jobs: clients.reduce((sum, client) => sum + client.jobCount, 0),
    active: clients.reduce((sum, client) => sum + client.activeJobs, 0),
  }), [clients]);

  return <div className="client-insights-review">
    <header className="client-page-heading">
      <div><span>CLIENT FACTS</span><h1>客户洞察</h1><p>按客户聚合当前可见职位事实，不推断合作意愿、转化率或经营优先级。</p></div>
      <dl><div><dt>客户</dt><dd>{totals.clients}</dd></div><div><dt>可见职位</dt><dd>{totals.jobs}</dd></div><div><dt>活跃职位</dt><dd>{totals.active}</dd></div></dl>
    </header>
    <div className="client-honesty"><ShieldAlert /><p><b>事实边界：</b>当前接口没有反馈速度、推荐转化、历史入职、招聘意愿和客户评分；最近活动仅代表职位快照时间，不等同于客户反馈。</p></div>
    <section className="client-table-card">
      <div className="client-toolbar">
        <label><Search /><span className="sr-only">搜索客户</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索客户或已知类型" /></label>
        <label className="client-check"><input type="checkbox" checked={onlyActive} onChange={event => setOnlyActive(event.target.checked)} />仅看有活跃职位</label>
        <label className="client-sort"><ArrowDownUp /><span className="sr-only">客户排序</span><select value={sort} onChange={event => setSort(event.target.value as ClientSort)}><option value="active">活跃职位优先</option><option value="hc">已知 HC 优先</option><option value="recent">最近快照优先</option></select></label>
      </div>
      <div className="client-table-wrap"><table><thead><tr><th>客户</th><th>职位总数</th><th>活跃职位</th><th>已知 HC</th><th>最近职位快照</th><th>顾问关系</th><th>职位状态</th><th aria-label="操作" /></tr></thead><tbody>
        {visible.map(client => <tr key={client.company}>
          <td><button className="client-name" type="button" onClick={() => setSelected(client)}><Building2 /><span><b>{client.company}</b><small>{client.companyType || "类型未标注"}</small></span></button></td>
          <td>{client.jobCount}</td><td>{client.activeJobs}</td><td>{client.knownHc ?? "—"}</td><td>{displayDate(client.lastActivity)}</td>
          <td><FactTags values={client.relations} labels={relationLabels} /></td><td><FactTags values={client.states} labels={stateLabels} /></td>
          <td><button className="client-open" type="button" aria-label={`查看 ${client.company} 事实`} onClick={() => setSelected(client)}><ChevronRight /></button></td>
        </tr>)}
      </tbody></table>{!visible.length && <div className="client-empty"><Search /><b>没有符合条件的客户</b><p>请清除搜索词或活跃职位筛选。</p></div>}</div>
    </section>
    {selected && <><button className="client-detail-backdrop" type="button" aria-label="关闭客户事实" onClick={() => setSelected(null)} /><aside className="client-detail" aria-label={`${selected.company} 客户事实`}><header><div><span>CLIENT FACT</span><h2>{selected.company}</h2><p>{selected.companyType || "客户类型未标注"}</p></div><button type="button" aria-label="关闭客户事实" onClick={() => setSelected(null)}><X /></button></header><dl>
      <div><dt>职位总数</dt><dd>{selected.jobCount}</dd></div><div><dt>活跃职位</dt><dd>{selected.activeJobs}</dd></div><div><dt>已知 HC</dt><dd>{selected.knownHc ?? "—"}</dd></div><div><dt>最近职位快照</dt><dd>{displayDate(selected.lastActivity)}</dd></div>
    </dl>
      <section><h3>顾问关系</h3><FactTags values={selected.relations} labels={relationLabels} /></section>
      <section><h3>职位状态</h3><FactTags values={selected.states} labels={stateLabels} /></section>
      <div className="client-detail-note"><ShieldAlert /><p>该客户暂无独立详情接口；这里不生成反馈速度、意愿或风险判断。</p></div>
      <button className="client-jobs-action" type="button" onClick={() => onOpenJobs?.(selected.company)}><BriefcaseBusiness />查看该客户的全部职位</button>
    </aside></>}
  </div>;
}
