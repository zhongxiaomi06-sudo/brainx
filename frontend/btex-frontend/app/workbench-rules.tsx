"use client";

import { useEffect, useState } from "react";
import { Check, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { brainxFetch, type BackendRecommendationRun } from "./brainx-api";
import { Heading } from "./workbench-controls";

const DIMENSIONS = [
  { dim: "direction", label: "职位方向匹配", note: "画像关键词与历史方向" },
  { dim: "activity", label: "项目活跃度与 Pipeline", note: "群活跃、优先级与新鲜度" },
  { dim: "similarity", label: "与历史项目相似度", note: "与你主做过的项目文本重合" },
  { dim: "capacity", label: "当前跟进容量", note: "关注与跟进项目越多，此维分越低" },
  { dim: "outcomes", label: "历史行为与交付结果", note: "交付评分；缺数据则不参与归一" },
  { dim: "exploration", label: "探索额度", note: "每日确定性探索位" },
] as const;

type DimKey = typeof DIMENSIONS[number]["dim"];
type WeightMap = Record<DimKey, number>;
type Profile = { weights?: Partial<WeightMap> | null; excluded_companies?: string[];
  excluded_roles?: string[]; excluded_cities?: string[]; capacity_limit?: number | null };
type ProfileUpdate = { ok: boolean; weights?: Partial<WeightMap> | null };
type Suggestion = { weights: WeightMap; reply: string };

const BASELINE: WeightMap = {
  direction: 25, activity: 20, similarity: 15, capacity: 15, outcomes: 15, exploration: 10,
};
const PRESETS: { label: string; weights: WeightMap }[] = [
  { label: "冲结果", weights: { direction: 20, activity: 25, similarity: 10, capacity: 10, outcomes: 25, exploration: 10 } },
  { label: "找增量", weights: { direction: 20, activity: 15, similarity: 20, capacity: 10, outcomes: 5, exploration: 30 } },
  { label: "发挥优势", weights: { direction: 30, activity: 15, similarity: 25, capacity: 10, outcomes: 10, exploration: 10 } },
  { label: "均衡推荐", weights: { direction: 17, activity: 17, similarity: 17, capacity: 17, outcomes: 16, exploration: 16 } },
];

function toPercentages(input?: Partial<WeightMap> | null): WeightMap {
  if (!input) return { ...BASELINE };
  const values = DIMENSIONS.map(({ dim }) => Number(input[dim] ?? BASELINE[dim]));
  const sum = values.reduce((total, value) => total + value, 0) || 1;
  const out = values.map((value) => Math.round((value / sum) * 100));
  out[out.indexOf(Math.max(...out))] += 100 - out.reduce((total, value) => total + value, 0);
  return Object.fromEntries(DIMENSIONS.map(({ dim }, index) => [dim, out[index]])) as WeightMap;
}

function WeightAdvisor({ onApply, notify }: { onApply: (weights: WeightMap) => void; notify: (text: string) => void }) {
  const [preference, setPreference] = useState("");
  const [reply, setReply] = useState("告诉我你的偏好，BrainX 会通过服务器模型生成六维建议；确认保存前不会改动推荐。");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const text = preference.trim();
    if (!text) return notify("先写一句你的判断偏好");
    setBusy(true);
    try {
      const result = await brainxFetch<Suggestion>("/api/v1/assistant/weight-suggestion", {
        method: "POST", body: { preference: text },
      });
      onApply(result.weights);
      setReply(result.reply);
    } catch (error) {
      setReply(`暂时无法生成建议：${error instanceof Error ? error.message : "模型服务未响应"}`);
    } finally { setBusy(false); }
  };
  return <div className="weight-advisor">
    <div className="weight-advisor-reply"><Sparkles/><span>{reply}</span></div>
    <textarea className="field" value={preference} onChange={(event) => setPreference(event.target.value)} maxLength={1000} placeholder="例如：多探索新机会，但仍要贴近我的广告投放经验。"/>
    <button className="btn primary" type="button" onClick={submit} disabled={busy}>{busy ? "分析中…" : "生成权重建议"}</button>
  </div>;
}

export function Rules({ notify, mode, policy, engine, keywords, note, onRefresh, onProfileSaved }: {
  notify: (text: string) => void; mode: "connecting" | "connected" | "offline";
  policy: string | null; engine: "baseline-1.1" | "agentic-ranking-v1"; keywords: string[]; note: string;
  onRefresh: () => Promise<void>; onProfileSaved: (keywords: string[], note: string) => void;
}) {
  const [weights, setWeights] = useState<WeightMap>({ ...BASELINE });
  const [customized, setCustomized] = useState(false);
  const [advisorOpen, setAdvisorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState(keywords.join("、"));
  const [noteDraft, setNoteDraft] = useState(note);
  const [excludedCompanies, setExcludedCompanies] = useState("");
  const [excludedRoles, setExcludedRoles] = useState("");
  const [excludedCities, setExcludedCities] = useState("");
  const [capacityLimit, setCapacityLimit] = useState("10");
  useEffect(() => {
    if (mode !== "connected") return;
    void brainxFetch<Profile>("/api/v1/profile").then((profile) => {
      setWeights(toPercentages(profile.weights)); setCustomized(!!profile.weights);
      setExcludedCompanies((profile.excluded_companies || []).join("、"));
      setExcludedRoles((profile.excluded_roles || []).join("、"));
      setExcludedCities((profile.excluded_cities || []).join("、"));
      setCapacityLimit(String(profile.capacity_limit || 10));
    }).catch(() => undefined);
  }, [mode, policy]);

  const saveWeights = async (next: WeightMap | null) => {
    setSaving(true);
    try {
      await brainxFetch<ProfileUpdate>("/api/v1/profile", { method: "PUT", body: { weights: next || {} } });
      const run = await brainxFetch<BackendRecommendationRun>("/api/v1/recommendations/run", { method: "POST" });
      await onRefresh();
      if (!next) { setWeights({ ...BASELINE }); setCustomized(false); }
      else setCustomized(true);
      notify(run.blocked ? "权重已保存；同步不完整，推荐暂未刷新" : "权重已保存，推荐已按新权重重算");
    } catch (error) {
      notify(`保存失败：${error instanceof Error ? error.message : "后端未响应"}`);
    } finally { setSaving(false); }
  };
  const split = (value: string) => value.split(/[、,，\n]+/).map(item => item.trim()).filter(Boolean);
  const saveProfile = async () => {
    const nextKeywords = keywordDraft.split(/[、,，\s]+/).filter(Boolean);
    try {
      await brainxFetch<ProfileUpdate>("/api/v1/profile", { method: "PUT", body: {
        profile_keywords: nextKeywords, profile_note: noteDraft,
        excluded_companies: split(excludedCompanies), excluded_roles: split(excludedRoles),
        excluded_cities: split(excludedCities), capacity_limit: Number(capacityLimit),
      } });
      onProfileSaved(nextKeywords, noteDraft); notify("主动偏好与容量已保存；下一轮 Agent 判断将生效");
    } catch (error) { notify(`保存失败：${error instanceof Error ? error.message : "后端未响应"}`); }
  };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return <>
    <Heading title="判断规则" desc={engine === "agentic-ranking-v1" ? "设置 Agent 使用的主动偏好、明确排除项与同时承接容量。" : "历史 baseline-1.1 软权重；不会影响 Algorithm A。"} action={<div className={`tag ${engine === "agentic-ranking-v1" ? "blue" : customized ? "orange" : "blue"}`}>{engine === "agentic-ranking-v1" ? "Agent 主动设置" : customized ? "历史自定义权重" : "历史基线权重"}</div>}/>
    {engine !== "agentic-ranking-v1" && <section className="card section"><div className="card-head"><h2>历史六维权重</h2><span>Policy {policy || "—"} · 合计 {total}%（仅 baseline-1.1）</span></div>
      <div className="card-body strategy-rules">
        <div className="preference-presets">{PRESETS.map((preset) => <button className="btn quiet" type="button" key={preset.label} onClick={() => setWeights({ ...preset.weights })}>{preset.label}</button>)}<button className="btn quiet" type="button" onClick={() => setAdvisorOpen((open) => !open)}>AI 建议</button></div>
        {advisorOpen && <WeightAdvisor onApply={setWeights} notify={notify}/>}
        {DIMENSIONS.map(({ dim, label, note: dimensionNote }) => <label className="rule-row" key={dim}><span><b>{label}</b><small>{dimensionNote}</small></span><input type="range" min="0" max="80" value={weights[dim]} disabled={mode !== "connected"} onChange={(event) => setWeights((current) => ({ ...current, [dim]: Number(event.target.value) }))}/><output>{weights[dim]}%</output></label>)}
        <div className="weight-save-actions"><button className="btn primary" disabled={mode !== "connected" || saving || total === 0} onClick={() => void saveWeights(weights)}><Check/>{saving ? "保存中…" : "保存并生成新推荐"}</button><button className="btn" disabled={mode !== "connected" || saving} onClick={() => void saveWeights(null)}><RotateCcw/>恢复基线</button></div>
        <p className="policy-boundary"><ShieldCheck/>只调软权重：HC、已入职、职位关闭、项目归属与数据冲突等硬规则不可调整。</p>
      </div></section>}
    {mode === "connected" && <section className="card section">
      <div className="card-head"><h2>{engine === "agentic-ranking-v1" ? "主动偏好、排除项与容量" : "方向画像"}</h2><span>下一轮推荐生效</span></div>
      <div className="card-body"><div className="toolbar">
        <input className="field" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} placeholder="画像关键词（顿号分隔）"/>
        <input className="field" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="画像备注（可选）"/>
        {engine === "agentic-ranking-v1" && <><input className="field" value={excludedCompanies} onChange={(event) => setExcludedCompanies(event.target.value)} placeholder="排除公司（顿号分隔）"/>
        <input className="field" value={excludedRoles} onChange={(event) => setExcludedRoles(event.target.value)} placeholder="排除职位（顿号分隔）"/>
        <input className="field" value={excludedCities} onChange={(event) => setExcludedCities(event.target.value)} placeholder="排除城市（顿号分隔）"/>
        <input className="field" type="number" min="1" max="100" value={capacityLimit} onChange={(event) => setCapacityLimit(event.target.value)} aria-label="同时承接容量" placeholder="同时承接容量"/></>}
        <button className="btn primary" onClick={() => void saveProfile()}><Check/>保存主动设置</button>
      </div></div>
    </section>}
  </>;
}
