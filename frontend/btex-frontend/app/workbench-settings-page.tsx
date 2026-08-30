"use client";

import { useEffect, useMemo, useState } from "react";
import { brainxFetch, type RadarFieldReport } from "./brainx-api";
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
  notify: (message: string) => void;
}) {
  const [ttc, setTtc] = useState<TtcStatus>(emptyTtc);
  const [talent, setTalent] = useState<TalentHealth>(emptyTalent);
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
      keywords,
      note: note || null,
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
  }), [auth, consultantId, fieldReport, keywords, note, policyVersion, sync, talent, ttc]);

  const handleAction = (action: "edit-profile" | "connect-ttc" | "reauthorize-feishu" | "open-strategy" | "refresh-diagnostics") => {
    if (action === "connect-ttc") return onOpenConnections();
    if (action === "reauthorize-feishu") {
      window.location.assign("/api/v1/oauth/authorize");
      return;
    }
    if (action === "refresh-diagnostics") return onRefresh();
    notify(action === "edit-profile" ? "方向画像将在下一批通过审核后的组件接入" : "推荐策略将在只读预演接口完成后接入");
  };

  return <SettingsCenterReview data={data} review={false} onBack={onBack} onAction={handleAction} />;
}

export { WorkbenchSettingsPage };
