/** MySQL prepared statements on some deployed versions reject LIMIT/OFFSET placeholders. */
const pageInteger = (value, fallback, max) =>
  Math.max(0, Math.min(max, Math.floor(Number(value) || fallback)));

export function buildTalentListQuery({ limit, offset, status }) {
  const safeLimit = Math.max(1, pageInteger(limit, 20, 100));
  const safeOffset = pageInteger(offset, 0, Number.MAX_SAFE_INTEGER);
  const where = status ? 'WHERE status=?' : '';
  return {
    sql: `SELECT * FROM talent ${where} ORDER BY last_active_time DESC, id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    args: status ? [status] : [],
  };
}
