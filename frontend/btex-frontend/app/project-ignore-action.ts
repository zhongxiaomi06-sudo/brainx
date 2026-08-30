import type { Dispatch, SetStateAction } from "react";
import { makeIdempotencyKey } from "./brainx-api";
import {
  removeOpportunityMembership,
  type ProjectSummary,
} from "./brainx-projects-api";
import type { MembershipRelation } from "./workbench-model";

type IgnoreContext = {
  mode: "connecting" | "connected" | "offline";
  focusedProjectId: string | null;
  setFocusedProjectId: Dispatch<SetStateAction<string | null>>;
  setProjects: Dispatch<SetStateAction<ProjectSummary[]>>;
  setMemberships: Dispatch<SetStateAction<Record<string, MembershipRelation>>>;
  notify: (text: string, options?: undefined, duration?: number) => void;
};

export function canIgnoreProject(project: ProjectSummary) {
  return project.project_status === "PENDING_START"
    && ["NEW", "RECOMMENDED", "VIEWED", "DISMISSED", "RELEASED", "EXPIRED"].includes(project.engagement_state);
}

export function createProjectIgnore(context: IgnoreContext) {
  return async (project: ProjectSummary) => {
    try {
      if (context.mode === "connected") {
        await removeOpportunityMembership(project.project_id,
          makeIdempotencyKey(`membership-remove:${project.project_id}`));
      }
      context.setProjects(current => current.filter(item => item.project_id !== project.project_id));
      context.setMemberships(current => {
        const next = { ...current };
        delete next[project.project_id];
        return next;
      });
      if (context.focusedProjectId === project.project_id) context.setFocusedProjectId(null);
      context.notify(`${project.company} · 已从我的项目移除`);
    } catch (error) {
      context.notify(`忽略失败：${error instanceof Error ? error.message : "后端未响应"}`, undefined, 4000);
      throw error;
    }
  };
}
