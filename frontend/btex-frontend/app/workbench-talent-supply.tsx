import { useEffect, useState } from "react";
import { getTalentSupply, type TalentSupplySnapshot } from "./brainx-api";
import type { DecisionJob } from "./workbench-model";
import { DrawerSection } from "./workbench-controls";

// —— 候选供给（人才侧适配层的前端呈现）——
// 数据形状对齐后端 talent-supply.js 的 TalentSupplySnapshot（GET /opportunities/:id/talent-supply）。
// 供给分析【旁路】：只做展示，绝不并入 job.finalScore（与后端「不进入基础评分」纪律一致）。
// 数据来源：真库匹配算法 supply-match-v1（技能0.5 + 意向0.3 + 摘要0.2）。前端不再造数——
// connected 且开关开启时拉真实结果；离线态不展示说明，未开启/失败只显示状态，绝不伪造数字。
const supplyDifficultyMeta: Record<"low" | "medium" | "high", { label: string; tone: string }> = {
  low: { label: "供给充足", tone: "ok" },
  medium: { label: "供给适中", tone: "warn" },
  high: { label: "供给偏紧", tone: "risk" },
};
function TalentSupplySection({
  job,
  mode,
}: {
  job: DecisionJob;
  mode: "connecting" | "connected" | "offline";
}) {
  const fetchKey = `${job.id}:${mode}`;
  const [result, setResult] = useState<{
    key: string;
    snap: TalentSupplySnapshot | null;
    error?: boolean;
  } | null>(null);
  useEffect(() => {
    if (mode !== "connected") return;
    let alive = true;
    getTalentSupply(job.id)
      .then((s) => {
        if (alive) setResult({ key: fetchKey, snap: s && s.enabled ? s : null });
      })
      .catch(() => {
        if (alive) setResult({ key: fetchKey, snap: null, error: true });
      });
    return () => {
      alive = false;
    };
  }, [job.id, mode, fetchKey]);
  // 状态完全由 props 与最近一次抓取结果派生：未连接即禁用、结果未回即加载中，无需在 effect 里同步置位
  const current = result && result.key === fetchKey ? result : null;
  const state =
    mode !== "connected"
      ? "disabled"
      : !current
        ? "loading"
        : current.error
          ? "error"
          : current.snap
            ? "ready"
            : "disabled";
  const snap = current?.snap ?? null;

  if (state === "ready" && snap) {
    const meta = supplyDifficultyMeta[snap.supplyDifficulty || "high"];
    return (
      <DrawerSection title="候选供给（人才侧参考）" collapsible defaultOpen={false}>
        <div className="supply-head">
          <div className="supply-count">
            <strong>{snap.matchableTalentCount ?? 0}</strong>
            <span>可匹配候选</span>
          </div>
          <span className={`supply-badge ${meta.tone}`}>{meta.label}</span>
          {(snap.reactivatableTalentCount ?? 0) > 0 && (
            <span className="supply-reactivate">可激活沉睡 {snap.reactivatableTalentCount} 人</span>
          )}
        </div>
        <p className="supply-suggestion">{snap.matchingSuggestion}</p>
        {(snap.topMatches?.length ?? 0) > 0 && (
          <div className="supply-matches">
            {snap.topMatches!.map((m) => (
              <div key={m.talentId} className="supply-match">
                <b>{m.name}</b>
                <span>
                  匹配 {Math.round(m.score * 100)}%
                  {m.matched?.length ? ` · ${m.matched.slice(0, 3).join("、")}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="snapshot-note">来源 {snap.algo || "talent-supply"} · 真库匹配 · 不计入最终得分</p>
      </DrawerSection>
    );
  }
  return (
    <DrawerSection title="候选供给（人才侧参考）" collapsible defaultOpen={false}>
      <p className="supply-suggestion muted">
        {mode !== "connected"
          ? "连接 BrainX 后展示人才库候选匹配"
          : state === "loading"
            ? "正在从人才库计算候选供给…"
            : state === "error"
              ? "供给计算暂不可用，请稍后重试"
              : "人才库暂无候选数据"}
      </p>
    </DrawerSection>
  );
}

export { TalentSupplySection };
