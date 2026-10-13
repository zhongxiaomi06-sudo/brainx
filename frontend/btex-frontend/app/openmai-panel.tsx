"use client";
import { useEffect, useState } from "react";
import type { OpenmaiResult } from "./brainx-api";
import { OpenmaiMarkdown } from "./openmai-markdown";
import { DrawerSection } from "./workbench-controls";
import { searchBriefApi, type SearchBrief } from "./search-brief-api";

type Props = { jobId: string; openmai: OpenmaiResult | null; mode: "connecting" | "connected" | "offline";
  onRerun: (jobId: string, searchBrief?: string) => void; briefApi?: typeof searchBriefApi };

export function OpenmaiPanel(props: Props) {
  if (props.mode !== "connected" || !props.openmai) return null;
  return <SearchEditor key={props.jobId} {...props} />;
}

function SearchEditor({ jobId, openmai, onRerun, briefApi = searchBriefApi }: Props) {
  const [stored, setStored] = useState<SearchBrief | null>(null);
  const [brief, setBrief] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    briefApi.load(jobId).then(value => {
      if (active) { setStored(value); setBrief(value.search_brief); }
    }).catch(() => { if (active) setError("找人条件加载失败，请重新打开职位重试。"); });
    return () => { active = false; };
  }, [jobId, briefApi]);
  const dirty = stored !== null && brief.trim() !== stored.search_brief;
  const running = openmai?.status === "running";
  const needsInput = openmai?.status === "needs_input";
  const save = async () => {
    if (!stored || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const value = await briefApi.save(jobId, brief.trim(), stored.version);
      setStored(value); setBrief(value.search_brief); setNotice("条件已保存，下次找人生效；本次没有启动搜索。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试；若版本冲突，请重新打开职位。"); }
    finally { setSaving(false); }
  };
  return <DrawerSection title="找人条件与结果">
    {running && <p className="muted">找人中，本轮条件已冻结。现在修改只影响下一轮。</p>}
    {openmai?.status === "failed" && <p role="status">找人失败：{openmai.error || "原因待确认"}</p>}
    {needsInput && <p>现有信息不足，请补充并保存条件，再明确启动找人。</p>}
    {openmai?.status === "done" && <OpenmaiMarkdown text={openmai.result_text || ""} />}
    <label style={{ display: "grid", gap: 8, margin: "12px 0" }}>
      <span>权威找人条件</span>
      <textarea aria-label="补充职位信息" value={brief} maxLength={2000} rows={5}
        disabled={!stored || saving} placeholder="填写职责、必备经验、城市、目标公司等；最多 2000 字"
        onChange={event => { setBrief(event.target.value); setNotice(""); }}
        style={{ border: "1px solid rgba(23,107,88,.25)", borderRadius: 12, padding: 12, font: "inherit", resize: "vertical" }} />
    </label>
    <p className="muted">OpenMai 与 SuperMai 下次按这份条件找人；群内补充只作用于当轮，不覆盖这里。</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <button className="btn" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "保存中…" : "保存条件"}</button>
      <button className="btn primary" onClick={() => onRerun(jobId, "")} disabled={!stored || dirty || saving || running}>
        {running ? "找人中…" : needsInput ? "用此画像开始找人" : "按已保存条件找人"}
      </button>
    </div>
  </DrawerSection>;
}
