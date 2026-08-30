"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock3, Search } from "lucide-react";
import type { ProjectStatus, ProjectSummary } from "./brainx-projects-api";
import { canIgnoreProject } from "./project-ignore-action";
import { Heading } from "./workbench-controls";

type ProjectFilter = "ALL" | ProjectStatus;

const filters: { id: ProjectFilter; label: string }[] = [
  { id: "ALL", label: "全部" },
  { id: "PENDING_START", label: "待开始" },
  { id: "IN_PROGRESS", label: "跟进中" },
  { id: "NEEDS_ACTION", label: "需处理" },
  { id: "COMPLETED", label: "已完成" },
  { id: "RELEASED", label: "已释放" },
];

const statusLabels: Record<ProjectStatus, string> = {
  PENDING_START: "待开始",
  IN_PROGRESS: "跟进中",
  NEEDS_ACTION: "需处理",
  COMPLETED: "已完成",
  RELEASED: "已释放",
};

const statusOrder: Record<ProjectStatus, number> = {
  NEEDS_ACTION: 0,
  PENDING_START: 1,
  IN_PROGRESS: 2,
  COMPLETED: 3,
  RELEASED: 4,
};

function dateText(value: string | null | undefined) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function dueText(project: ProjectSummary) {
  if (!project.active_action) return null;
  if (project.active_action.status === "BLOCKED") return `阻塞 · ${dateText(project.active_action.due_at)} 检查`;
  const due = new Date(project.active_action.due_at).getTime();
  if (!Number.isFinite(due)) return "截止待确认";
  const days = Math.ceil((due - Date.now()) / 86400000);
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天截止";
  if (days === 1) return "明天截止";
  return `${dateText(project.active_action.due_at)} 截止`;
}

function nextStep(project: ProjectSummary) {
  if (project.project_status === "PENDING_START") return "确认目标、第一行动和截止时间";
  if (project.project_status === "NEEDS_ACTION") return project.active_action?.status === "BLOCKED" ? "处理阻塞并更新下一行动" : "更新当前行动";
  if (project.project_status === "IN_PROGRESS") return "记录进展并建立下一行动";
  return "查看项目记录";
}

function actionLabel(project: ProjectSummary) {
  if (project.project_status === "PENDING_START") return "开始跟进";
  if (project.project_status === "NEEDS_ACTION") return "立即处理";
  if (project.project_status === "IN_PROGRESS") return "更新进展";
  return "查看记录";
}

function matches(project: ProjectSummary, query: string) {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return true;
  return [project.company, project.role, project.current_stage, project.active_action?.goal,
    project.active_action?.title, project.next_action]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(keyword);
}

export function ProjectsView({ projects, query, setQuery, focusedProjectId, open, onIgnore }: {
  projects: ProjectSummary[];
  query: string;
  setQuery: (value: string) => void;
  focusedProjectId: string | null;
  open: (project: ProjectSummary) => void;
  onIgnore: (project: ProjectSummary) => Promise<void>;
}) {
  const [filter, setFilter] = useState<ProjectFilter>("ALL");
  const [ignoringId, setIgnoringId] = useState<string | null>(null);
  const counts = useMemo(() => Object.fromEntries(filters.map(({ id }) => [id,
    id === "ALL" ? projects.length : projects.filter(project => project.project_status === id).length,
  ])) as Record<ProjectFilter, number>, [projects]);
  const visible = useMemo(() => projects
    .filter(project => filter === "ALL" || project.project_status === filter)
    .filter(project => matches(project, query))
    .sort((a, b) => statusOrder[a.project_status] - statusOrder[b.project_status]
      || String(a.active_action?.due_at || "9999").localeCompare(String(b.active_action?.due_at || "9999"))
      || b.joined_at.localeCompare(a.joined_at)), [filter, projects, query]);
  const isFiltered = filter !== "ALL" || Boolean(query.trim());

  useEffect(() => {
    if (!focusedProjectId) return;
    document.getElementById(`project-${focusedProjectId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedProjectId, projects]);

  return <div className="decision-home projects-home">
    <Heading code="MY PROJECTS" title="我的项目" desc="按行动状态安排今天要推进的项目。" />
    <section className="projects-summary">
      <div><span>{isFiltered ? "当前显示" : "项目总数"}</span><b>{isFiltered ? `${visible.length}/${projects.length}` : projects.length}</b><small>个真实项目归属</small></div>
      <p>需处理和逾期项目优先；状态、行动与截止时间均来自后端。</p>
    </section>
    <div className="projects-toolbar">
      <label className="concept-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目、公司、目标或当前行动" aria-label="搜索我的项目" /></label>
      <div className="project-status-tabs" aria-label="项目状态筛选">
        {filters.map(item => <button type="button" key={item.id} className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
          {item.label}<span>{counts[item.id]}</span>
        </button>)}
      </div>
    </div>
    <div className="project-action-list">
      {visible.length ? visible.map(project => {
        const due = dueText(project);
        const urgent = project.project_status === "NEEDS_ACTION";
        const canIgnore = canIgnoreProject(project);
        return <article id={`project-${project.project_id}`} className={`project-action-card status-${project.project_status.toLocaleLowerCase()}${focusedProjectId === project.project_id ? " is-focused" : ""}`} key={project.project_id} aria-label={`${project.role} · ${project.company}`}>
          <div className="project-identity">
            <div><span className="project-status">{urgent ? <AlertTriangle /> : project.project_status === "COMPLETED" ? <CheckCircle2 /> : <Clock3 />}{statusLabels[project.project_status]}</span><small>{project.relation === "MY_JOB" ? "我的职位" : "团队共享"}</small></div>
            <h2>{project.role}</h2><p>{project.company}{project.city ? ` · ${project.city}` : ""}</p>
          </div>
          <div className="project-action-copy">
            <span>{project.active_action ? "当前行动" : project.project_status === "PENDING_START" ? "下一步" : "项目状态"}</span>
            <b>{project.active_action?.title || project.next_action || (project.project_status === "PENDING_START" ? "建立第一条跟进行动" : statusLabels[project.project_status])}</b>
            <small>{project.active_action?.goal ? `目标：${project.active_action.goal}` : nextStep(project)}</small>
          </div>
          <div className="project-action-side">
            <span className={urgent ? "urgent" : ""}>{due || `更新于 ${dateText(project.state_since || project.joined_at)}`}</span>
            <div className="project-card-actions">
              {canIgnore && <button
                type="button" className="is-ignore" disabled={ignoringId === project.project_id}
                onClick={() => { setIgnoringId(project.project_id); void onIgnore(project).finally(() => setIgnoringId(null)); }}>
                {ignoringId === project.project_id ? "忽略中…" : "忽略"}
              </button>}
              <button type="button" className="is-primary" onClick={() => open(project)}>{actionLabel(project)}<ChevronRight /></button>
            </div>
          </div>
        </article>;
      }) : <div className="empty projects-empty"><Search /><b>{isFiltered ? "当前条件下没有项目" : "还没有加入任何项目"}</b><p>{isFiltered ? "切换状态或修改搜索内容。" : "从精选盘或全部职位点击“加入我的项目”。"}</p></div>}
    </div>
  </div>;
}
