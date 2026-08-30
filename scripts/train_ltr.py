#!/usr/bin/env python3
"""train_ltr.py — LambdaMART 离线训练（算法文档 §3.3/§7 阶段二）。
读取 bin/brainx-ltr-export.mjs 产出的 JSONL，按 run_id 排序组训练
LightGBM LambdaRank，输出模型 JSON（供 src/shadow-rank.js 线上只读推理）。

纪律（§4/§6）：按时间切分 train/valid（后 20% 组做验证），不用未来预测过去；
NDCG@10 只作影子对照，不作上线判据。

用法：
  uv run --with lightgbm scripts/train_ltr.py [data/ltr-export.jsonl] [--out data/ltr-model.json]
  或已装 lightgbm 时：python3 scripts/train_ltr.py ...
"""
import json
import sys
from pathlib import Path

def load_rows(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        header = json.loads(f.readline())
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return header, rows

def main():
    import lightgbm as lgb
    import numpy as np

    src = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'data/ltr-export.jsonl'
    out = 'data/ltr-model.json'
    if '--out' in sys.argv:
        out = sys.argv[sys.argv.index('--out') + 1]

    header, rows = load_rows(src)
    order = header['feature_order']
    if len(rows) < 30:
        print(json.dumps({'ok': False, 'reason': f'样本不足（{len(rows)}<30），先积累曝光与互动再训练',
                          'rows': len(rows)}, ensure_ascii=False))
        sys.exit(2)

    # LambdaRank 要求同一查询组在数据内连续：先按组聚合（组时间=组内最早 created_at），
    # 组按时间排序，再展开为行序列；时间切分按组前 80% 训练、后 20% 验证（§4 不用未来）。
    by_group = {}
    for r in rows:
        by_group.setdefault(r['group'], []).append(r)
    group_keys = sorted(by_group, key=lambda g: min(x['created_at'] for x in by_group[g]))
    cut = max(1, int(len(group_keys) * 0.8))
    train_keys, valid_keys = group_keys[:cut], group_keys[cut:]

    def pack(keys):
        Xs, ys, sizes = [], [], []
        for g in keys:
            for r in by_group[g]:
                Xs.append([r['features'][k] for k in order])
                ys.append(r['label'])
            sizes.append(len(by_group[g]))
        return np.array(Xs, dtype=float), np.array(ys, dtype=float), sizes

    Xtr, ytr, group_train = pack(train_keys)
    has_valid = bool(valid_keys) and sum(len(by_group[g]) for g in valid_keys) > 0
    if has_valid:
        Xva, yva, group_valid = pack(valid_keys)

    model = lgb.LGBMRanker(objective='lambdarank', metric='ndcg', ndcg_eval_at=[10],
                           n_estimators=120, learning_rate=0.08, num_leaves=15,
                           min_data_in_leaf=5, feature_fraction=0.9, verbose=-1)
    model.fit(Xtr, ytr, group=group_train,
              eval_set=[(Xva, yva)] if has_valid else None,
              eval_group=[group_valid] if has_valid else None)
    X = np.vstack([Xtr] + ([Xva] if has_valid else []))
    y = np.concatenate([ytr] + ([yva] if has_valid else []))
    rows_sorted = [r for g in train_keys + (valid_keys if has_valid else []) for r in by_group[g]]

    dump = model.booster_.dump_model()
    payload = {
        'format': 'lightgbm-lambdarank-json',
        'feature_version': header['feature_version'],
        'feature_order': order,
        'trained_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'rows': len(rows), 'train_groups': len(train_keys),
        'model': dump,
    }
    Path(out).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')

    # 快速对照：验证集 NDCG@10（规则 rank vs 模型分）
    def ndcg(scores, labels, groups, k=10):
        vals, off = [], 0
        for g in groups:
            seg_s, seg_l = scores[off:off+g], labels[off:off+g]
            idx = np.argsort(-seg_s)[:k]
            dcg = sum((2**seg_l[i]-1)/np.log2(i+2) for i, _ in enumerate(idx))
            ideal = np.sort(-seg_l)[:k]*-1
            idcg = sum((2**l-1)/np.log2(i+2) for i, l in enumerate(ideal))
            if idcg > 0: vals.append(dcg/idcg)
            off += g
        return float(np.mean(vals)) if vals else None

    report = {'ok': True, 'out': out, 'rows': len(rows)}
    if has_valid:
        report['ndcg10_model'] = ndcg(model.predict(Xva), yva, group_valid)
        report['ndcg10_rule_baseline'] = ndcg(-np.array([r['rank'] for r in rows_sorted[len(Xtr):]]), yva, group_valid)
    print(json.dumps(report, ensure_ascii=False))

if __name__ == '__main__':
    main()
