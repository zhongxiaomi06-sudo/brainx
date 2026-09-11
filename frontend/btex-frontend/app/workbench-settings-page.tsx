"use client";

import { useEffect, useMemo, useState } from "react";
import { brainxFetch, type BackendProfileUpdate, type BackendRecommendationRun, type RadarFieldReport } from "./brainx-api";
import type { AuthStatus, SyncStatus } from "./decision-demo";
import { SettingsCenterReview, type SettingsCenterData } from "./settings-center-review";

type TtcStatus = {
  connected: boolean;
  ttc_user_name?: string;
  expires_at?: string;
  needs_reauth?: boolean;
};

type TalentHealth = {
  backend: string;
  connected: boolean;
  schema: string;
  degraded: string | null;
  config?: { host: string; database: string | null };
};

const emptyTtc: TtcStatus = { connected: false, needs_reauth: false };
const emptyTalent: TalentHealth = { backend: "—", connected: false, schema: "—", degraded: null };

function fieldNames(report: RadarFieldReport | null, available: boolean) {
  return report?.fields.filter(field => field.filterAvailable === available).map(field => field.label) || [];
}

function WorkbenchSettingsPage({
  auth,
  consultantId,
  keywords,
  note,
  policyVersion,
  sync,
  fieldReport,
  onBack,
  onOpenConnections,
  onRefresh,
  onProfileSaved,
  notify,
}: {
  auth: AuthStatus;
  consultantId: string;
  keywords: string[];
  note: string;
  policyVersion: string | null;
  sync: SyncStatus;
  fieldReport: RadarFieldReport | null;
  onBack: () => void;
  onOpenConnections: () => void;
  onRefresh: () => void;
  onProfileSaved: (keywords: string[], note: string) => Promise<void> | void;
  notify: (message: string) => void;
}) {
  const [ttc, setTtc] = useState<TtcStatus>(emptyTtc);
  const [talent, setTalent] = useState<TalentHealth>(emptyTalent);
  const [savedProfile, setSavedProfile] = useState({ keywords, note });
  useEffect(() => {
    let active = true;
    void Promise.all([
      brainxFetch<TtcStatus>("/api/v1/ttc/connect").catch(() => emptyTtc),
      brainxFetch<TalentHealth>("/api/v1/talent/health").catch(() => emptyTalent),
    ]).then(([nextTtc, nextTalent]) => {
      if (!active) return;
      setTtc(nextTtc);
      setTalent(nextTalent);
    });
    return () => { active = false; };
  }, []);

  const data = useMemo<SettingsCenterData>(() => ({
    profile: {
      consultantId,
      displayName: auth.consultant,
      keywords: savedProfile.keywords,
      note: savedProfile.note || null,
      feishuAuthorized: auth.authorized,
      feishuNeedsReauth: auth.needsReauth,
    },
    ttc: {
      connected: ttc.connected,
      userName: ttc.ttc_user_name || null,
      expiresAt: ttc.expires_at || null,
      needsReauth: !!ttc.needs_reauth,
    },
    talent: {
      backend: talent.backend,
      connected: talent.connected,
      schema: talent.schema,
      database: talent.config?.database || null,
      host: talent.config?.host || null,
      degraded: talent.degraded,
    },
    strategy: { policyVersion, customized: null },
    sync: {
      state: sync.state === "READY" ? "READY" : sync.state === "ERROR" ? "ERROR" : sync.state === "EMPTY" ? "EMPTY" : "INCOMPLETE",
      rowsRead: sync.rowsRead ?? null,
      rowsExpected: sync.rowsExpected ?? null,
      updatedAt: sync.updatedAt,
      errors: sync.errors || [],
      fieldReport: fieldReport ? {
        schemaVersion: fieldReport.schemaVersion,
        totalRows: fieldReport.totalRows,
        filterableFields: fieldNames(fieldReport, true),
        unavailableFilters: fieldNames(fieldReport, false),
      } : null,
    },
  }), [auth, consultantId, fieldReport, policyVersion, savedProfile, sync, talent, ttc]);

  const saveDirection = async (nextKeywords: string[]) => {
    const updated = await brainxFetch<BackendProfileUpdate>("/api/v1/profile", {
      method: "PUT", body: { profile_keywords: nextKeywords },
    });
    const savedKeywords = updated.profile_keywords || nextKeywords;
    const savedNote = updated.profile_note ?? savedProfile.note;
    setSavedProfile({ keywords: savedKeywords, note: savedNote });
    let refreshed = true;
    let refreshMessage = "";
    try {
      await brainxFetch<BackendRecommendationRun>("/api/v1/recommendations/run", { method: "POST" });
    } catch (error) {
      refreshed = false;
      refreshMessage = error instanceof Error ? error.message : "当前职位快照不可用";
    }
    try {
      await onProfileSaved(savedKeywords, savedNote);
    } catch {
      // 保存与重算已经由后端确认；父页面快照稍后仍可通过常规刷新重新读取。
    }
    notify(refreshed
      ? "方向画像已保存；精选盘与机器人岗位推荐已按新方向刷新"
      : `方向画像已保存；推荐暂未刷新：${refreshMessage}`);
  };

  const handleAction = (action: "edit-profile" | "connect-ttc" | "reauthorize-feishu" | "open-strategy" | "refresh-diagnostics" | "logout") => {
    if (action === "logout") {
      void brainxFetch<null>("/api/v1/session", { method: "DELETE" })
        .then(() => window.location.reload())
        .catch(error => notify(`退出失败：${error instanceof Error ? error.message : "后端未响应"}`));
      return;
    }
    if (action === "connect-ttc") return onOpenConnections();
    if (action === "reauthorize-feishu") {
      window.location.assign("/api/v1/oauth/authorize");
      return;
    }
    if (action === "refresh-diagnostics") return onRefresh();
    notify(action === "edit-profile" ? "方向画像将在下一批通过审核后的组件接入" : "推荐策略将在只读预演接口完成后接入");
  };

  const initialSection = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("settings") === "model" ? "model" : "profile";
  return <SettingsCenterReview data={data} initialSection={initialSection} review={false} onBack={onBack} onAction={handleAction} onSaveDirection={saveDirection} />;
}

export { WorkbenchSettingsPage };
