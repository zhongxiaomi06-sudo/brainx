/** 今日推送卡预览(不发送;真发送只能在 brainx-push.mjs --send 人工执行)。 */
import { latestSync, latestCompleteSnapshot } from '../../sync.js';
import { latestRun, loadConsultants } from '../../recommend.js';
import { commitmentSummary } from '../../engagement.js';
import { buildDailyCard, buildSyncAlertCard } from '../../push.js';

export default {
  name: 'brainx_push_preview',
  description: '预览当前顾问的今日推送卡片(只预览,不发送)。同步异常时返回同步告警卡。',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) => {
    const { db, cid } = ctx;
    const sync = latestSync(db, cid);
    const snapshot = latestCompleteSnapshot(db, cid);
    const run = latestRun(db, cid, { hideEngaged: true });
    const c = commitmentSummary(db, cid);
    const name = loadConsultants(db).find((x) => x.consultant_id === cid)?.display_name || cid;
    return sync && !sync.complete ? buildSyncAlertCard(sync)
      : buildDailyCard({ consultant_name: name, consultant_id: cid, run: run?.run, items: run?.items || [],
                         commitments: c, sync, snapshot_id: snapshot?.sync_id });
  },
};
