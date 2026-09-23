/**
 * 推荐兼容 facade。
 *
 * 新入口应注入 recommendation-use-case；本文件保留历史导出，让内部调用与测试渐进迁移。
 */
import { createRecommendationUseCase, publicRecommendation } from './recommendation-use-case.js';

const useCase = (db) => createRecommendationUseCase(db);

export const loadConsultants = (db) => useCase(db).consultants();
export const buildCtx = (db, consultantId, snapshot) => useCase(db)
  .buildContext(consultantId, snapshot);
export const recommend = (db, consultantId, options = {}) => useCase(db)
  .run(consultantId, options);
export const recommendationRun = (db, consultantId, runId = null, options = {}) => useCase(db)
  .readRun(consultantId, runId, options);
export const latestRun = (db, consultantId, options = {}) => useCase(db)
  .latest(consultantId, options);
export const hideEngagedItems = (db, consultantId, items) => useCase(db)
  .hideEngaged(consultantId, items);
export const publicRec = publicRecommendation;
