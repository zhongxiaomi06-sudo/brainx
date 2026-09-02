export async function runWorkerOnce({ repository, handlers, workerId, now = new Date(), costUnits = 1 }) {
  const job = repository.claim({ workerId, now, costUnits, kinds: Object.keys(handlers) });
  if (!job) return null;
  const handler = handlers[job.kind];
  if (typeof handler !== 'function') {
    return repository.fail(job.job_id, workerId, { code: 'HANDLER_DISABLED', now });
  }
  try {
    const result = await handler(job.payload, { job });
    const latest = repository.get(job.job_id);
    if (latest.status === 'CANCELLED') return latest;
    return repository.complete(job.job_id, workerId, { resultRef: result?.result_ref, now });
  } catch (error) {
    return repository.fail(job.job_id, workerId, {
      code: error?.code || 'HANDLER_FAILED',
      summary: error?.safeSummary || null,
      retryable: error?.retryable === true,
      now,
    });
  }
}
