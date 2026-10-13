import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOperationsDashboard } from "../app/operations-dashboard-model.ts";

test("operations dashboard keeps LIVE and SHADOW separate and preserves unknown evidence", () => {
  const model = normalizeOperationsDashboard({
    schema_version: "operations_dashboard.v1",
    freshness: { metric_version: "operations-dashboard-v1", status: "READY", checkpoint: 9,
      max_sequence: 9, backlog: 0, last_event_at: "2026-09-24T09:00:00.000Z",
      projected_at: "2026-09-24T10:00:00.000Z", lag_seconds: 3600 },
    operations: { sync: { complete: 1, incomplete: 0, failed: 0 },
      jobs: { pending: 0, running: 0, succeeded: 1, failed: 0 }, delivery_failed: 0 },
    funnel: { served: 2, visible: 1, accepted: 1, interview: 0, offer: 0, onboard: 0,
      shadow_exposures: 0, shadow_outcomes: 0 },
    ranking: { live: { published: 1, failed: 0, abstained: 0, recommendation_items: 2 },
      shadow: { completed: 1, failed: 0, avg_top_10_overlap: 0.5, avg_ndcg_delta: null,
        labeled_candidates: 0, hard_violations: 0 } },
    cost: { live: { calls: 1, known_calls: 0, total_tokens: null, estimated_cost_micros: null,
      failed_calls: 0, p95_latency_ms: null }, shadow: { calls: 1, known_calls: 1,
      total_tokens: 20, estimated_cost_micros: 10, failed_calls: 0, p95_latency_ms: 50 } },
    capacity: { current_jobs: 2, fact_versions: 3, daily_growth: [] },
    backup: { status: "NOT_REPORTED", completed_at: null, size_bytes: null,
      restore_verified: null },
    sample_maturity: { exposed_decisions: 2, attributed_decisions: 0, rate: null },
    sources: [], caveats: [],
  });
  assert.equal(model.cost.live.total_tokens, null);
  assert.equal(model.cost.shadow.total_tokens, 20);
  assert.equal(model.backup.status, "NOT_REPORTED");
  assert.equal(model.health, "READY");
  assert.doesNotMatch(JSON.stringify(model), /score|probability/);
});

test("operations dashboard marks backlog and projection failure as attention states", () => {
  const model = normalizeOperationsDashboard({
    schema_version: "operations_dashboard.v1",
    freshness: { metric_version: "operations-dashboard-v1", status: "FAILED", checkpoint: 4,
      max_sequence: 8, backlog: 4, last_event_at: null, projected_at: null, lag_seconds: null },
  });
  assert.equal(model.health, "FAILED");
  assert.equal(model.freshness.backlog, 4);
  assert.equal(model.backup.status, "NOT_REPORTED");
});
