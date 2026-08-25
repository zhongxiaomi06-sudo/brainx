"use client";

import type React from "react";
import { useEffect, useEffectEvent, useState } from "react";
import { Pencil, X } from "lucide-react";
import { BrainxApiError, makeIdempotencyKey, updateOpportunityFacts, type ManualFactField } from "./brainx-api";
import { DrawerSection } from "./workbench-controls";
import type { DecisionJob } from "./workbench-model";

const factFieldByLabel: Record<string, ManualFactField> = { 职位状态: "active_state", 当前阶段: "current_stage", "剩余 HC": "remaining_hc", "历史 Pipeline": "pipeline_snapshot", 下一步动作: "next_action", 备注: "notes" };
const factEditorLabels: Record<ManualFactField, string> = { active_state: "职位状态", current_stage: "当前阶段", pipeline_snapshot: "Pipeline", remaining_hc: "剩余 HC", next_action: "下一步动作", notes: "备注" };
const factSourceLabels = { SYNC: "同步", MANUAL: "手动修正", UNKNOWN: "未知", LOCAL: "本机草稿" } as const;
type LocalFactOverride = Partial<Record<ManualFactField, string | number>>;
const LOCAL_FACT_STORAGE_KEY = "brainx-manual-fact-overrides-v1";
function readLocalFactOverrides(): Record<string, LocalFactOverride> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(LOCAL_FACT_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}
function writeLocalFactOverrides(value: Record<string, LocalFactOverride>) {
  if (typeof window !== "undefined") localStorage.setItem(LOCAL_FACT_STORAGE_KEY, JSON.stringify(value));
}

export function ManualFactSection({ job, mode, onUpdated, notify, editRequest = 0 }: { job: DecisionJob; mode: "connecting" | "connected" | "offline"; onUpdated: () => Promise<void>; notify: (text: string) => void; editRequest?: number }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localOverrides, setLocalOverrides] = useState<Record<string, LocalFactOverride>>(() => readLocalFactOverrides());
  const [values, setValues] = useState<Record<ManualFactField, string>>({ active_state: "", current_stage: "", pipeline_snapshot: "", remaining_hc: "", next_action: "", notes: "" });
  const [clearFields, setClearFields] = useState<ManualFactField[]>([]);
  const local = localOverrides[job.id] || {};
  const fallbackValue = (field: ManualFactField): string | number | null => {
    if (field === "active_state") {
      const state = job.facts["职位状态"];
      return ({ 招聘中: "OPEN", 冷却期: "COOLING", 已关闭: "CLOSED", 已完成: "COMPLETED" } as Record<string, string>)[state] || null;
    }
    if (field === "current_stage") return job.facts["当前阶段"] || null;
    if (field === "remaining_hc") {
      const hc = job.facts["剩余 HC"];
      return hc && hc !== "UNKNOWN" ? Number(hc) : null;
    }
    if (field === "pipeline_snapshot") return job.facts["历史 Pipeline"] && job.facts["历史 Pipeline"] !== "暂无记录" ? job.facts["历史 Pipeline"] : null;
    if (field === "next_action") return job.facts["下一步动作"] || null;
    return job.facts["备注"] || null;
  };
  const effectiveValue = (field: ManualFactField) => local[field] ?? job.factFields?.[field]?.effective_value ?? fallbackValue(field);
  const sourceOfField = (field: ManualFactField) => (local[field] !== undefined ? { source: "LOCAL" as const, effective_value: local[field] } : job.factFields?.[field]);
  const readValues = () => Object.fromEntries((Object.keys(factEditorLabels) as ManualFactField[]).map((field) => [field, String(effectiveValue(field) ?? "")])) as Record<ManualFactField, string>;
  const beginEdit = () => {
    setValues(readValues());
    setClearFields([]);
    setEditing(true);
  };
  const beginEditFromEvent = useEffectEvent(() => beginEdit());
  useEffect(() => {
    const openFacts = (event: Event) => {
      if ((event as CustomEvent<string>).detail === job.id && mode !== "connecting") beginEditFromEvent();
    };
    window.addEventListener("brainx:edit-facts", openFacts);
    return () => window.removeEventListener("brainx:edit-facts", openFacts);
  }, [job.id, mode, editRequest]);
  const toggleClear = (field: ManualFactField) => setClearFields((current) => (current.includes(field) ? current.filter((item) => item !== field) : [...current, field]));
  const saveLocal = (changes: Partial<Record<ManualFactField, string | number>>, clears: Set<ManualFactField>) => {
    const all = readLocalFactOverrides();
    const next = { ...(all[job.id] || {}) };
    clears.forEach((field) => delete next[field]);
    Object.assign(next, changes);
    const saved = { ...all, [job.id]: next };
    writeLocalFactOverrides(saved);
    setLocalOverrides(saved);
    setEditing(false);
    notify("事实已保存到当前浏览器；后端上线后再重新生成评分");
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === "connecting") return;
    const changes: Partial<Record<ManualFactField, string | number>> = {};
    const clears = new Set<ManualFactField>(clearFields);
    const textFields: ManualFactField[] = ["active_state", "current_stage", "pipeline_snapshot", "next_action", "notes"];
    for (const field of textFields) {
      if (clears.has(field)) continue;
      const value = values[field].trim();
      if (value) changes[field] = value;
      else if (job.factFields?.[field]?.source === "MANUAL") clears.add(field);
    }
    if (!clears.has("remaining_hc") && values.remaining_hc.trim()) {
      const n = Number(values.remaining_hc);
      if (!Number.isInteger(n) || n < 0) {
        notify("剩余 HC 必须是 0 或更大的整数");
        return;
      }
      changes.remaining_hc = n;
    } else if (!values.remaining_hc.trim() && job.factFields?.remaining_hc?.source === "MANUAL") clears.add("remaining_hc");
    if (mode === "offline") {
      saveLocal(changes, clears);
      return;
    }
    setSaving(true);
    try {
      const result = await updateOpportunityFacts(job.id, { changes, clear_fields: Array.from(clears), idempotency_key: makeIdempotencyKey(`facts:${job.id}`) });
      await onUpdated();
      setEditing(false);
      notify(result.recompute?.blocked ? "事实已保存，但当前快照暂未重算" : "事实已更新，判断已重新生成");
    } catch (error) {
      if (error instanceof BrainxApiError && [0, 404, 502, 503].includes(error.status)) {
        saveLocal(changes, clears);
        notify("后端尚未更新，事实已先保存到当前浏览器");
      } else notify(`保存失败：${error instanceof Error ? error.message : "后端未响应"}`);
    } finally {
      setSaving(false);
    }
  };
  const sourceOf = (label: string) => {
    const field = factFieldByLabel[label];
    return field ? sourceOfField(field) : undefined;
  };
  const editable = mode !== "connecting";
  const displayFacts = { ...job.facts };
  (Object.keys(factFieldByLabel) as string[]).forEach((label) => {
    const field = factFieldByLabel[label];
    const value = effectiveValue(field);
    if (value !== null && value !== undefined && value !== "")
      displayFacts[label] = field === "active_state" ? ({ OPEN: "招聘中", COOLING: "冷却期", CLOSED: "已关闭", COMPLETED: "已完成" } as Record<string, string>)[String(value)] || String(value) : String(value);
  });
  return (
    <DrawerSection
      title="当前事实"
      action={
        editable ? (
          <button type="button" className="fact-edit-trigger" onClick={editing ? () => setEditing(false) : beginEdit}>
            {editing ? (
              <>
                <X aria-hidden="true" />
                取消编辑
              </>
            ) : (
              <>
                <Pencil aria-hidden="true" />
                编辑
              </>
            )}
          </button>
        ) : (
          <span className="fact-readonly">正在连接</span>
        )
      }
    >
      <dl className="facts">
        {Object.entries(displayFacts).map(([key, value]) => {
          const source = sourceOf(key);
          return (
            <div key={key}>
              <dt>{key}</dt>
              <dd className={value === "UNKNOWN" ? "unknown" : ""}>
                {value}
                {source && <small className={`fact-source ${source.source.toLowerCase()}`}>{factSourceLabels[source.source]}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
      {editing && (
        <form className="fact-edit-form" onSubmit={save}>
          <label>
            职位状态
            <select
              value={values.active_state}
              onChange={(e) => {
                setValues((v) => ({ ...v, active_state: e.target.value }));
                setClearFields((v) => v.filter((f) => f !== "active_state"));
              }}
            >
              <option value="">请选择</option>
              <option value="OPEN">活跃 / 招聘中</option>
              <option value="COOLING">冷却期</option>
              <option value="CLOSED">已关闭</option>
              <option value="COMPLETED">已完成</option>
            </select>
          </label>
          <label>
            当前阶段
            <input
              value={values.current_stage}
              onChange={(e) => {
                setValues((v) => ({ ...v, current_stage: e.target.value }));
                setClearFields((v) => v.filter((f) => f !== "current_stage"));
              }}
              placeholder="例如：INTERVIEW / OFFER"
            />
          </label>
          <label>
            剩余 HC
            <input type="number" min="0" step="1" value={values.remaining_hc} onChange={(e) => setValues((v) => ({ ...v, remaining_hc: e.target.value }))} placeholder="未知可留空" />
          </label>
          <label>
            Pipeline
            <input
              value={values.pipeline_snapshot}
              onChange={(e) => {
                setValues((v) => ({ ...v, pipeline_snapshot: e.target.value }));
                setClearFields((v) => v.filter((f) => f !== "pipeline_snapshot"));
              }}
              placeholder="例如：推荐 3 · 面试 1"
            />
          </label>
          <label>
            下一步动作
            <input
              value={values.next_action}
              onChange={(e) => {
                setValues((v) => ({ ...v, next_action: e.target.value }));
                setClearFields((v) => v.filter((f) => f !== "next_action"));
              }}
              placeholder="例如：确认客户反馈"
            />
          </label>
          <label>
            备注
            <textarea
              value={values.notes}
              onChange={(e) => {
                setValues((v) => ({ ...v, notes: e.target.value }));
                setClearFields((v) => v.filter((f) => f !== "notes"));
              }}
              placeholder="补充事实来源或判断依据"
            />
          </label>
          <div className="fact-restore-list">
            {(Object.keys(factEditorLabels) as ManualFactField[])
              .filter((field) => job.factFields?.[field]?.source === "MANUAL")
              .map((field) => (
                <button key={field} type="button" className={clearFields.includes(field) ? "selected" : ""} onClick={() => toggleClear(field)}>
                  {clearFields.includes(field) ? "将恢复同步值" : "恢复同步值"} · {factEditorLabels[field]}
                </button>
              ))}
          </div>
          <div className="fact-edit-actions">
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "保存并重算…" : "保存并重新判断"}
            </button>
          </div>
          <p className="fact-edit-caption">{mode === "connected" ? "只修正当前账号的事实；保存后按后端规则重算，不直接修改分数。" : "当前后端未连接；先保存本机草稿。确认事实后，必须完成重新判断，分数才会更新。"}</p>
        </form>
      )}
    </DrawerSection>
  );
}
