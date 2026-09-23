/** SQLite recommendation repository：推荐用例唯一的数据访问边界。 */
import { latestBridgeError, latestCompleteSnapshot, latestRealSync,
  friendlyBridgeError } from './sync.js';
import { listConsultants } from './roster.js';
import { relationMap } from './relations.js';
import { currentState } from './engagement.js';
import { effectiveJobs } from './facts.js';
import { writeImpressions } from './tier.js';
import { ignoredProjectIds } from './opportunity-ignore.js';

export function createRecommendationRepository(db) {
  return Object.freeze({
    consultants: () => listConsultants(db),

    syncState(consultantId) {
      const last = latestRealSync(db, consultantId);
      const snapshot = latestCompleteSnapshot(db, consultantId);
      const bridgeError = latestBridgeError(db, consultantId, last?.completed_at || '');
      const syncWarning = bridgeError ? {
        at: bridgeError.started_at,
        ...friendlyBridgeError(bridgeError.errors),
        last_complete_at: snapshot?.completed_at || null,
      } : null;
      return { last, snapshot, syncWarning };
    },

    contextData(consultantId) {
      const consultant = listConsultants(db)
        .find((item) => item.consultant_id === consultantId) || {};
      const historicalTexts = db.prepare(`SELECT DISTINCT j.company || ' ' || j.role AS text
        FROM job_memberships m JOIN job_facts j ON j.project_id = m.project_id
        WHERE m.consultant_id=? AND m.relation IN ('MY_JOB','PRIMARY_PM')`)
        .all(consultantId).map((item) => item.text);
      const acceptedCount = db.prepare(`SELECT COUNT(*) n FROM current_engagement
        WHERE consultant_id=? AND state='ACCEPTED'`).get(consultantId).n;
      const outcomesAvg = db.prepare(`SELECT AVG(json_extract(value_json,'$.rating')) a FROM job_outcomes
        WHERE consultant_id=? AND json_extract(value_json,'$.rating') IS NOT NULL`)
        .get(consultantId).a;
      const feedbackProjects = db.prepare(`SELECT project_id FROM recommendation_feedback
        WHERE consultant_id=?`).all(consultantId).map((item) => item.project_id);
      feedbackProjects.push(...ignoredProjectIds(db, consultantId));
      const negativeCompanies = db.prepare(`SELECT DISTINCT j.company FROM decision_events e
        JOIN job_facts j ON j.project_id=e.project_id
        WHERE e.actor=? AND e.event_type='DISMISSED'
        UNION SELECT DISTINCT j.company FROM recommendation_feedback f
        JOIN job_facts j ON j.project_id=f.project_id
        WHERE f.consultant_id=?
        UNION SELECT DISTINCT j.company FROM opportunity_ignores i
        JOIN job_facts j ON j.project_id=i.project_id
        WHERE i.consultant_id=?`).all(consultantId, consultantId, consultantId).map((item) => item.company);
      const positiveCompanies = db.prepare(`SELECT DISTINCT j.company FROM decision_events e
        JOIN job_facts j ON j.project_id=e.project_id
        WHERE e.actor=? AND e.event_type='ACCEPTED'`).all(consultantId).map((item) => item.company);
      const recommendationRounds = Object.fromEntries(db.prepare(`SELECT project_id,
        COUNT(DISTINCT run_id) n FROM recommendations WHERE consultant_id=? GROUP BY project_id`)
        .all(consultantId).map((item) => [item.project_id, item.n]));
      const engagedProjects = new Set(db.prepare(`SELECT DISTINCT project_id FROM decision_events
        WHERE actor=? AND event_type != 'RECOMMENDED'`).all(consultantId).map((item) => item.project_id));
      return {
        consultant, historicalTexts, acceptedCount, outcomesAvg, feedbackProjects,
        negativeCompanies, positiveCompanies, recommendationRounds, engagedProjects,
      };
    },

    candidates(consultantId) {
      return {
        jobs: effectiveJobs(db, consultantId),
        relations: relationMap(db, consultantId),
        ignored: ignoredProjectIds(db, consultantId),
      };
    },

    latestCompletedRun(consultantId) {
      return db.prepare(`SELECT run_id, snapshot_id, created_at FROM decision_runs
        WHERE consultant_id=? AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`)
        .get(consultantId);
    },

    latestThrottleAudit(consultantId) {
      return db.prepare(`SELECT created_at FROM decision_runs
        WHERE consultant_id=? AND status='SKIPPED_THROTTLED' ORDER BY created_at DESC LIMIT 1`)
        .get(consultantId);
    },

    insertThrottleAudit({ runId, consultantId, snapshotId, policyVersion, createdAt }) {
      db.prepare(`INSERT INTO decision_runs
        (run_id, consultant_id, snapshot_id, policy_version, candidate_count, status, created_at)
        VALUES (?,?,?,?,0,'SKIPPED_THROTTLED',?)`)
        .run(runId, consultantId, snapshotId, policyVersion, createdAt);
    },

    persistRun({ runId, consultantId, snapshotId, policyVersion, evaluated,
      top, persistLimit, createdAt }) {
      const insertRun = db.prepare(`INSERT INTO decision_runs
        (run_id, consultant_id, snapshot_id, policy_version, candidate_count, status, created_at)
        VALUES (?,?,?,?,?,'COMPLETED',?)`);
      const insertRecommendation = db.prepare(`INSERT INTO recommendations
        (decision_id, run_id, project_id, consultant_id, action, score, confidence_band,
         evidence_coverage, reasons_json, risks_json, evidence_refs_json, breakdown_json,
         policy_version, rank, created_at, feature_snapshot_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      db.exec('BEGIN');
      try {
        insertRun.run(runId, consultantId, snapshotId, policyVersion, evaluated.length, createdAt);
        for (const item of evaluated.slice(0, Math.max(top, persistLimit))) {
          insertRecommendation.run(item.decision_id, runId, item.project_id, consultantId,
            item.action, item.score, item.confidence_band, item.evidence_coverage,
            JSON.stringify(item.reasons), JSON.stringify(item.risks),
            JSON.stringify(item.evidence_refs), JSON.stringify(item.breakdown),
            policyVersion, item.rank, createdAt, item.feature_snapshot_json);
        }
        writeImpressions(db, { run_id: runId, consultant_id: consultantId,
          items: evaluated, top, policy_version: policyVersion });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    readRun(consultantId, runId = null) {
      const run = runId
        ? db.prepare(`SELECT * FROM decision_runs
          WHERE consultant_id=? AND run_id=? AND status='COMPLETED'`).get(consultantId, runId)
        : db.prepare(`SELECT * FROM decision_runs
          WHERE consultant_id=? AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`)
          .get(consultantId);
      if (!run) return null;
      return {
        run,
        rows: db.prepare('SELECT * FROM recommendations WHERE run_id=? ORDER BY rank').all(run.run_id),
        jobs: effectiveJobs(db, consultantId),
        relations: relationMap(db, consultantId),
      };
    },

    hiddenProjectIds(consultantId) {
      const feedback = db.prepare(`SELECT project_id FROM recommendation_feedback
        WHERE consultant_id=?`).all(consultantId).map((item) => item.project_id);
      return new Set([...feedback, ...ignoredProjectIds(db, consultantId)]);
    },

    engagementState: (consultantId, projectId) => currentState(db, consultantId, projectId).state,
  });
}
