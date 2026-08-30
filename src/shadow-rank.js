/** shadow-rank.js — LambdaMART 影子推理（算法文档 §7 阶段二：只读运行）。
 * 读 scripts/train_ltr.py 产出的 LightGBM JSON dump，在 JS 里走树集成打分。
 * 影子纪律：永不改变线上正式队列；只用于对照评估（eval-ranking --shadow）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { LTR_FEATURES } from './ltr-features.js';

function walkTree(node, f) {
  // LightGBM dump: decision node 有 split_feature/threshold/decision_type(<=), 叶子有 leaf_value
  if (node.leaf_value !== undefined) return node.leaf_value;
  const fv = f[node.split_feature];
  const goLeft = fv === null || fv === undefined || Number.isNaN(fv)
    ? node.default_left !== false
    : fv <= node.threshold;
  return walkTree(goLeft ? node.left_child : node.right_child, f);
}

export function loadShadowModel(path) {
  if (!path || !existsSync(path)) return null;
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  if (payload?.format !== 'lightgbm-lambdarank-json' || !payload.model?.tree_info) return null;
  const order = payload.feature_order || LTR_FEATURES;
  const trees = payload.model.tree_info.map((t) => t.tree_structure);
  const lr = payload.model.learning_rate ?? 1;
  return {
    feature_order: order,
    trained_at: payload.trained_at,
    rows: payload.rows,
    score(featObj) {
      let s = 0;
      for (const tree of trees) s += lr * walkTree(tree, featObj);
      return s;
    },
  };
}

/** 对一组 (rec, ctx) 打分：返回按影子分降序的 project_id 序列（供 NDCG 对照）。 */
export function shadowScores(model, recs, ctx, featuresOf) {
  if (!model) return null;
  return recs.map((r) => ({ project_id: r.project_id || r.job?.project_id,
                            shadow: model.score(featuresOf(r, ctx)) }));
}
