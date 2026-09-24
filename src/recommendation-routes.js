/** 推荐队列、反馈与人工重算 HTTP 路由。 */
import { body, err, json } from './server-http.js';
import { pickTray, nextBatch, feedback, undoFeedback } from './recommendation-batch.js';
import { recommendationPage } from './recommendation-page.js';
import { quickActionRoute } from './quick-action-route.js';
import { createRecommendationUseCase } from './recommendation-use-case.js';
import { agenticRecommendationPage } from './agentic-ranking/presentation.js';

export function recommendationRoutes(db, {
  recommendations = createRecommendationUseCase(db),
  bus,
  projectLaunch,
  agenticReadEnabled = process.env.BRAINX_AGENTIC_READ === '1',
} = {}) {
  return {
    'GET /api/v1/recommendations': (req, res, consultantId, query) => {
      const readPage = agenticReadEnabled ? agenticRecommendationPage : recommendationPage;
      const output = readPage(db, consultantId, {
        cursor: query.get('cursor'),
        search: query.get('q'),
        sort: query.get('sort'),
        recommendations,
      });
      if (output.ok === false) {
        return err(res, output.status, output.code, output.message);
      }
      json(res, 200, output);
    },
    'GET /api/v1/recommendations/pick-tray': (req, res, consultantId, query) => {
      json(res, 200, pickTray(db, consultantId, {
        limit: query.get('limit'), cursor: query.get('cursor'),
      }, { recommendations }));
    },
    'POST /api/v1/recommendations/feedback': async (req, res, consultantId) => {
      const output = feedback(db, consultantId, await body(req), { recommendations, agenticReadEnabled });
      json(res, output.ok ? 200 : output.status || 422, output);
    },
    'POST /api/v1/recommendations/feedback/undo': async (req, res, consultantId) => {
      const output = undoFeedback(db, consultantId, await body(req), { recommendations, agenticReadEnabled });
      json(res, output.ok ? 200 : output.status || 422, output);
    },
    'GET /api/v1/feedback/quick': quickActionRoute(db, bus, projectLaunch),
    'POST /api/v1/recommendations/next-batch': async (req, res, consultantId) => {
      const output = nextBatch(db, consultantId, await body(req), { recommendations });
      json(res, output.ok ? 200 : output.status || 409, output);
    },
    'POST /api/v1/recommendations/run': (req, res, consultantId) => {
      const output = recommendations.run(consultantId, { top: 20 });
      json(res, output.blocked ? 409 : 200, output);
    },
  };
}
