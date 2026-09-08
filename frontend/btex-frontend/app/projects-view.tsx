"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, Clock3, Search } from "lucide-react";
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
  if (project.launch?.search_status === "RUNNING") return "机器人正在搜索并评估首轮候选人";
  if (project.launch?.search_status === "DONE") return "候选人结果已回传飞书项目群";
  if (project.launch?.search_status === "FAILED") return project.launch.error_message || "寻访失败，可重试";
  if (project.launch?.status === "READY") return "项目群和职位卡已就绪，连接 TTC 后启动 OpenMai";
  if (project.project_status === "PENDING_START") return "自动建群、投放职位并启动 OpenMai";
  if (project.project_status === "NEEDS_ACTION") return project.active_action?.status === "BLOCKED" ? "处理阻塞并更新下一行动" : "更新当前行动";
  if (project.project_status === "IN_PROGRESS") return "记录进展并建立下一行动";
  return "查看项目记录";
}

function actionLabel(project: ProjectSummary) {
  if (project.launch?.search_status === "RUNNING") return "OpenMai 找人中";
  if (project.launch?.search_status === "DONE") return "查看候选人";
  if (project.launch?.search_status === "FAILED" || project.launch?.status === "FAILED") return "重试飞书寻访";
  if (project.launch?.status === "READY") return "启动 OpenMai 找人";
  if (project.project_status === "PENDING_START") return "在飞书启动寻访";
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

export function ProjectsView({ projects, query, setQuery, focusedProjectId, open, onIgnore, onLaunch }: {
  projects: ProjectSummary[];
  query: string;
  setQuery: (value: string) => void;
  focusedProjectId: string | null;
  open: (project: ProjectSummary) => void;
  onIgnore: (project: ProjectSummary) => Promise<void>;
  onLaunch: (project: ProjectSummary) => Promise<void>;
}) {
  const [filter, setFilter] = useState<ProjectFilter>("ALL");
  const [ignoringId, setIgnoringId] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchErrors, setLaunchErrors] = useState<Record<string, string>>({});
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
        const canLaunch = project.project_status === "PENDING_START"
          || project.launch?.status === "FAILED" || project.launch?.search_status === "FAILED";
        const launching = launchingId === project.project_id;
        return <article id={`project-${project.project_id}`} className={`project-action-card status-${project.project_status.toLocaleLowerCase()}${focusedProjectId === project.project_id ? " is-focused" : ""}`} key={project.project_id} aria-label={`${project.role} · ${project.company}`}>
          <div className="project-identity">
            <div><span className="project-status">{urgent ? <AlertTriangle /> : project.project_status === "COMPLETED" ? <CheckCircle2 /> : <Clock3 />}{statusLabels[project.project_status]}</span><small>{project.relation === "MY_JOB" ? "我的职位" : "团队共享"}</small></div>
            <h2>{project.role}</h2><p>{project.company}{project.city ? ` · ${project.city}` : ""}</p>
          </div>
          <div className="project-action-copy">
            <span>{project.active_action ? "当前行动" : project.project_status === "PENDING_START" ? "下一步" : "项目状态"}</span>
            <b>{project.launch?.search_status === "RUNNING" ? "OpenMai 正在搜索和评估候选人"
              : project.launch?.search_status === "DONE" ? "候选人已投递到飞书项目群"
              : project.active_action?.title || project.next_action || (project.project_status === "PENDING_START" ? "创建飞书项目群并自动找人" : statusLabels[project.project_status])}</b>
            <small>{project.active_action?.goal ? `目标：${project.active_action.goal}` : nextStep(project)}</small>
            {launchErrors[project.project_id] && <small className="project-launch-error" role="alert">{launchErrors[project.project_id]}</small>}
          </div>
          <div className="project-action-side">
            <span className={urgent ? "urgent" : ""}>{due || `更新于 ${dateText(project.state_since || project.joined_at)}`}</span>
            <div className="project-card-actions">
              {canIgnore && <button
                type="button" className="is-ignore" disabled={ignoringId === project.project_id}
                onClick={() => { setIgnoringId(project.project_id); void onIgnore(project).finally(() => setIgnoringId(null)); }}>
                {ignoringId === project.project_id ? "忽略中…" : "忽略"}
              </button>}
              <button type="button" className="is-primary" disabled={launching || project.launch?.search_status === "RUNNING"}
                onClick={() => {
                  if (!canLaunch) { open(project); return; }
                  setLaunchingId(project.project_id);
                  setLaunchErrors(current => ({ ...current, [project.project_id]: "" }));
                  void onLaunch(project)
                    .catch(error => setLaunchErrors(current => ({ ...current,
                      [project.project_id]: error instanceof Error ? error.message : "启动失败，请重试" })))
                    .finally(() => setLaunchingId(null));
                }}>
                {canLaunch && <Bot />}{launching ? "正在创建项目群…" : actionLabel(project)}{!canLaunch && <ChevronRight />}
              </button>
            </div>
          </div>
        </article>;
      }) : <div className="empty projects-empty"><Search /><b>{isFiltered ? "当前条件下没有项目" : "还没有加入任何项目"}</b><p>{isFiltered ? "切换状态或修改搜索内容。" : "从精选盘或全部职位点击“加入我的项目”。"}</p></div>}
    </div>
  </div>;
}
