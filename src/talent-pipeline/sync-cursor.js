export async function runCursorSync({
  initialCursor = null,
  pageSize = 100,
  maxPages = 10_000,
  fetchPage,
  writePage,
  saveCursor,
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('PAGE_SIZE_INVALID');
  if (![fetchPage, writePage, saveCursor].every(item => typeof item === 'function')) throw new Error('SYNC_DEPENDENCY_INVALID');
  let cursor = initialCursor;
  let itemsProcessed = 0;
  let pagesProcessed = 0;
  for (;;) {
    if (pagesProcessed >= maxPages) throw new Error('SOURCE_PAGE_LIMIT');
    const page = await fetchPage({ cursor, limit: pageSize });
    if (!page || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw new Error('SOURCE_PAGE_INVALID');
    if (page.items.length > pageSize || (page.hasMore && (!page.items.length || !page.nextCursor))) {
      throw new Error('SOURCE_PAGE_INVALID');
    }
    if (page.hasMore && String(page.nextCursor) === String(cursor)) throw new Error('SOURCE_CURSOR_STALLED');
    await writePage(page.items, { cursor, nextCursor: page.nextCursor });
    itemsProcessed += page.items.length;
    pagesProcessed += 1;
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) break;
  }
  await saveCursor(cursor);
  return { items_processed: itemsProcessed, pages_processed: pagesProcessed, final_cursor: cursor };
}
