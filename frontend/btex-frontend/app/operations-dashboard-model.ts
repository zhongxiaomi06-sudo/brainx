export type MetricCost = {
  calls: number; known_calls: number; total_tokens: number | null;
  estimated_cost_micros: number | null; failed_calls: number; p95_latency_ms: number | null;
};

export type OperationsDashboardModel = {
  schema_version: string;
  metric_version: string;
  health: "READY" | "ATTENTION" | "FAILED" | "EMPTY";
  freshness: { metric_version: string; status: string; checkpoint: number; max_sequence: number;
    backlog: number; last_event_at: string | null; projected_at: string | null; lag_seconds: number | null };
  operations: { sync: { complete: number; incomplete: number; failed: number };
    jobs: { pending: number; running: number; succeeded: number; failed: number; cancelled: number };
    delivery_failed: number };
  funnel: { served: number; visible: number; accepted: number; interview: number; offer: number;
    onboard: number; shadow_exposures: number; shadow_outcomes: number };
  ranking: { live: { published: number; failed: number; abstained: number; recommendation_items: number };
    shadow: { completed: number; failed: number; avg_top_10_overlap: number | null;
      avg_ndcg_delta: number | null; labeled_candidates: number; hard_violations: number } };
  cost: { live: MetricCost; shadow: MetricCost };
  capacity: { current_jobs: number; fact_versions: number;
    daily_growth: Array<{ date: string; new_jobs: number }> };
  backup: { status: string; completed_at: string | null; size_bytes: number | null;
    restore_verified: boolean | null };
  sample_maturity: { exposed_decisions: number; attributed_decisions: number; rate: number | null };
  sources: Array<{ metric: string; sources: string[]; grain: string }>;
  caveats: string[];
};

const zeroCost: MetricCost = { calls: 0, known_calls: 0, total_tokens: null,
  estimated_cost_micros: null, failed_calls: 0, p95_latency_ms: null };

export function normalizeOperationsDashboard(input: Partial<OperationsDashboardModel>): OperationsDashboardModel {
  const freshness = { metric_version: "operations-dashboard-v1", status: "EMPTY", checkpoint: 0,
    max_sequence: 0, backlog: 0, last_event_at: null, projected_at: null, lag_seconds: null,
    ...(input.freshness || {}) };
  const health = freshness.status === "FAILED" ? "FAILED" : freshness.status === "EMPTY" ? "EMPTY"
    : ["BACKLOG", "STALE"].includes(freshness.status) ? "ATTENTION" : "READY";
  return {
    schema_version: input.schema_version || "operations_dashboard.v1",
    metric_version: input.metric_version || freshness.metric_version,
    health,
    freshness,
    operations: {
      sync: { complete: 0, incomplete: 0, failed: 0, ...(input.operations?.sync || {}) },
      jobs: { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0,
        ...(input.operations?.jobs || {}) },
      delivery_failed: input.operations?.delivery_failed || 0,
    },
    funnel: { served: 0, visible: 0, accepted: 0, interview: 0, offer: 0, onboard: 0,
      shadow_exposures: 0, shadow_outcomes: 0, ...(input.funnel || {}) },
    ranking: {
      live: { published: 0, failed: 0, abstained: 0, recommendation_items: 0,
        ...(input.ranking?.live || {}) },
      shadow: { completed: 0, failed: 0, avg_top_10_overlap: null, avg_ndcg_delta: null,
        labeled_candidates: 0, hard_violations: 0, ...(input.ranking?.shadow || {}) },
    },
    cost: { live: { ...zeroCost, ...(input.cost?.live || {}) },
      shadow: { ...zeroCost, ...(input.cost?.shadow || {}) } },
    capacity: { current_jobs: 0, fact_versions: 0, daily_growth: [], ...(input.capacity || {}) },
    backup: { status: "NOT_REPORTED", completed_at: null, size_bytes: null,
      restore_verified: null, ...(input.backup || {}) },
    sample_maturity: { exposed_decisions: 0, attributed_decisions: 0, rate: null,
      ...(input.sample_maturity || {}) },
    sources: input.sources || [], caveats: input.caveats || [],
  };
}
