/** 外部搜索前先读已有授权短名单；只读，不计算新匹配，不取得额外授权。 */
export async function internalFirst(read, jobId, principal) {
  if (!jobId) return { status: 'not_supported', note: '内部短名单需要职位；自由条件检索尚无授权接口。' };
  if (!read) return { status: 'unavailable', note: '内部人才库尚未接通，不能当作零命中。' };
  try {
    const result = await read({ job_id: jobId, limit: 3 }, { principal });
    const data = result?.data;
    if (!data || result.ok === false) throw new Error('UNAVAILABLE');
    const count = Number(data.items_count ?? data.items?.length);
    if (!Number.isFinite(count)) throw new Error('UNAVAILABLE');
    return { status: count ? 'matched' : 'empty', count,
      card_delivered: data.card_delivered === true,
      note: count ? '已有内部人选；本次外部搜索仍来自顾问明确选择，不代表内部无人。' : '当前授权短名单为空，不代表整个人才库无人。' };
  } catch {
    return { status: 'unavailable', note: '内部人才库读取失败，不是假零命中；仅执行本次已明确选择的外部搜索。' };
  }
}
