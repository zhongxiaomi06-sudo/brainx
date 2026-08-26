import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Search, X } from "lucide-react";
import "./ttc-jobs-table.css";

export type TtcJobStatus = "OPEN" | "COOLING" | "CLOSED" | "UNKNOWN";

export type TtcJobTableRow = {
  projectId: string;
  role: string;
  company: string;
  cities: string[];
  activeState: TtcJobStatus;
  hc: number | null;
  pipeline: Record<string, number> | null;
  ownerName: string | null;
  capturedAt: string | null;
};

export type TtcFieldCapability = {
  key: "company" | "city" | "active_state" | "hc" | "owner_name";
  displayAvailable: boolean;
  filterAvailable: boolean;
  coverage: number;
};

type FilterKey = TtcFieldCapability["key"];
type SortKey = "hc" | "capturedAt";
type FilterState = Partial<Record<FilterKey, string>>;

const statusLabel: Record<TtcJobStatus, string> = {
  OPEN: "活跃",
  COOLING: "冷却",
  CLOSED: "已关闭",
  UNKNOWN: "待确认",
};

const filterLabel: Record<FilterKey, string> = {
  company: "公司",
  city: "城市",
  active_state: "TTC 状态",
  hc: "HC",
  owner_name: "主做顾问",
};

const pipelineLabel: Record<string, string> = {
  sourcing: "Sourcing",
  recommendation: "推荐",
  recommended: "推荐",
  interview: "面试",
  offer: "Offer",
  onboard: "入职",
};

function formatPipeline(pipeline: TtcJobTableRow["pipeline"]) {
  if (!pipeline) return "待确认";
  const stages = Object.entries(pipeline)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([key, value]) => `${pipelineLabel[key.toLowerCase()] || key} ${value}`);
  return stages.length ? stages.join(" · ") : "待确认";
}

function formatDate(value: string | null) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function FilterMenu({
  filterKey,
  options,
  selected,
  capability,
  open,
  onToggle,
  onSelect,
}: {
  filterKey: FilterKey;
  options: string[];
  selected?: string;
  capability?: TtcFieldCapability;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: string | undefined) => void;
}) {
  const available = capability?.filterAvailable ?? true;
  const reason = capability && !available
    ? `当前仅 ${Math.round(capability.coverage * 100)}% 的职位有该字段，暂不开放筛选`
    : undefined;
  return (
    <div className="ttc-table-filter">
      <button
        type="button"
        className={selected ? "is-filtered" : ""}
        aria-label={`筛选${filterLabel[filterKey]}`}
        aria-expanded={available ? open : undefined}
        disabled={!available}
        title={reason}
        onClick={onToggle}
      >
        <span>{filterLabel[filterKey]}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {!available && <small title={reason}>不可筛选</small>}
      {open && available && (
        <div className="ttc-table-filter-menu" role="listbox" aria-label={`${filterLabel[filterKey]}筛选项`}>
          <button type="button" role="option" aria-selected={!selected} onClick={() => onSelect(undefined)}>全部</button>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={selected === option}
              className={selected === option ? "selected" : ""}
              key={option}
              onClick={() => onSelect(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TtcJobsTable({
  rows,
  capabilities = [],
  onOpen,
}: {
  rows: TtcJobTableRow[];
  capabilities?: TtcFieldCapability[];
  onOpen: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>({});
  const [openFilter, setOpenFilter] = useState<FilterKey | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "capturedAt", direction: "desc" });
  const root = useRef<HTMLElement>(null);
  const capabilityByKey = useMemo(() => Object.fromEntries(capabilities.map((item) => [item.key, item])), [capabilities]);

  useEffect(() => {
    if (!openFilter) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenFilter(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenFilter(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openFilter]);

  const options = useMemo(() => ({
    company: [...new Set(rows.map((row) => row.company).filter(Boolean))].sort(),
    city: [...new Set(rows.flatMap((row) => row.cities).filter(Boolean))].sort(),
    active_state: [...new Set(rows.map((row) => statusLabel[row.activeState]))],
    hc: ["有 HC", "待确认"],
    owner_name: [...new Set(rows.map((row) => row.ownerName).filter((value): value is string => Boolean(value)))].sort(),
  }), [rows]);

  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const filtered = rows.filter((row) => {
      const searchable = [row.role, row.company, ...row.cities, row.ownerName || "", formatPipeline(row.pipeline)]
        .join(" ").toLocaleLowerCase("zh-CN");
      if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
      if (filters.company && row.company !== filters.company) return false;
      if (filters.city && !row.cities.includes(filters.city)) return false;
      if (filters.active_state && statusLabel[row.activeState] !== filters.active_state) return false;
      if (filters.owner_name && row.ownerName !== filters.owner_name) return false;
      if (filters.hc === "有 HC" && row.hc === null) return false;
      if (filters.hc === "待确认" && row.hc !== null) return false;
      return true;
    });
    return filtered.sort((left, right) => {
      const leftValue = sort.key === "hc" ? left.hc : left.capturedAt ? Date.parse(left.capturedAt) : null;
      const rightValue = sort.key === "hc" ? right.hc : right.capturedAt ? Date.parse(right.capturedAt) : null;
      if (leftValue === null && rightValue === null) return 0;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      const delta = leftValue - rightValue;
      return sort.direction === "asc" ? delta : -delta;
    });
  }, [filters, query, rows, sort]);

  const setFilter = (key: FilterKey, value?: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setOpenFilter(null);
  };
  const reset = () => {
    setFilters({});
    setQuery("");
    setOpenFilter(null);
  };
  const toggleSort = (key: SortKey) => setSort((current) => current.key === key
    ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
    : { key, direction: "desc" });
  const sortIcon = (key: SortKey) => sort.key === key
    ? sort.direction === "desc" ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />
    : null;
  const activeFilters = Object.entries(filters).filter((entry): entry is [FilterKey, string] => Boolean(entry[1]));

  return (
    <section className="ttc-jobs-table" ref={root}>
      <div className="ttc-jobs-table-notice"><b>审核预览</b><span>示例已脱敏，字段形状与 TTC 职位库一致；正式工作台尚未接入。</span></div>
      <header className="ttc-jobs-table-heading">
        <div><span>TTC JOB FACTS</span><h2>全部职位</h2><p>只展示可以从职位源核验的核心事实</p></div>
        <strong>{visibleRows.length} / {rows.length}</strong>
      </header>
      <div className="ttc-jobs-table-toolbar">
        <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索职位或公司" placeholder="搜索职位、公司、城市或顾问" /></label>
        {(query || activeFilters.length > 0) && <button type="button" onClick={reset}>清除全部</button>}
      </div>
      {activeFilters.length > 0 && (
        <div className="ttc-jobs-table-chips" aria-label="已选条件">
          <span>已选条件</span>
          {activeFilters.map(([key, value]) => <button type="button" key={key} onClick={() => setFilter(key)}>{filterLabel[key]}：{value}<X aria-hidden="true" /></button>)}
        </div>
      )}
      <div className="ttc-jobs-table-scroll">
        <table>
          <thead><tr>
            <th>职位</th>
            <th><FilterMenu filterKey="company" options={options.company} selected={filters.company} capability={capabilityByKey.company} open={openFilter === "company"} onToggle={() => setOpenFilter((current) => current === "company" ? null : "company")} onSelect={(value) => setFilter("company", value)} /></th>
            <th><FilterMenu filterKey="city" options={options.city} selected={filters.city} capability={capabilityByKey.city} open={openFilter === "city"} onToggle={() => setOpenFilter((current) => current === "city" ? null : "city")} onSelect={(value) => setFilter("city", value)} /></th>
            <th><FilterMenu filterKey="active_state" options={options.active_state} selected={filters.active_state} capability={capabilityByKey.active_state} open={openFilter === "active_state"} onToggle={() => setOpenFilter((current) => current === "active_state" ? null : "active_state")} onSelect={(value) => setFilter("active_state", value)} /></th>
            <th><div className="ttc-jobs-table-sort"><FilterMenu filterKey="hc" options={options.hc} selected={filters.hc} capability={capabilityByKey.hc} open={openFilter === "hc"} onToggle={() => setOpenFilter((current) => current === "hc" ? null : "hc")} onSelect={(value) => setFilter("hc", value)} /><button type="button" aria-label="按 HC 排序" onClick={() => toggleSort("hc")}>{sortIcon("hc") || <ArrowDown aria-hidden="true" />}</button></div></th>
            <th>Pipeline 进展</th>
            <th><FilterMenu filterKey="owner_name" options={options.owner_name} selected={filters.owner_name} capability={capabilityByKey.owner_name} open={openFilter === "owner_name"} onToggle={() => setOpenFilter((current) => current === "owner_name" ? null : "owner_name")} onSelect={(value) => setFilter("owner_name", value)} /></th>
            <th><button className="ttc-jobs-table-date-sort" type="button" onClick={() => toggleSort("capturedAt")}>最近更新{sortIcon("capturedAt")}</button></th>
            <th>操作</th>
          </tr></thead>
          <tbody>
            {visibleRows.map((row) => <tr key={row.projectId}>
              <td><b>{row.role || "待确认"}</b><small>{row.projectId}</small></td>
              <td>{row.company || "待确认"}</td>
              <td>{row.cities.length ? row.cities.join("、") : "待确认"}</td>
              <td><span className={`ttc-job-status is-${row.activeState.toLowerCase()}`}>{statusLabel[row.activeState]}</span></td>
              <td>{row.hc ?? "待确认"}</td>
              <td><span className="ttc-job-pipeline" title={formatPipeline(row.pipeline)}>{formatPipeline(row.pipeline)}</span></td>
              <td>{row.ownerName || "待确认"}</td>
              <td>{formatDate(row.capturedAt)}</td>
              <td><button className="ttc-job-open" type="button" onClick={() => onOpen(row.projectId)}>详情</button></td>
            </tr>)}
          </tbody>
        </table>
        {visibleRows.length === 0 && <div className="ttc-jobs-table-empty"><b>{rows.length ? "没有符合条件的职位" : "TTC 暂无职位"}</b><p>{rows.length ? "调整或清除条件后再查看。" : "同步完成后，真实职位会显示在这里。"}</p>{rows.length > 0 && <button type="button" onClick={reset}>清除条件</button>}</div>}
      </div>
    </section>
  );
}
