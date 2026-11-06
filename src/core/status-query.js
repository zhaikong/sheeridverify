import { setTimeout as delay } from 'node:timers/promises';

// Initial routing and browser preflight are read-only and may retry briefly.
// Never replay submissions, uploads, client errors, or rate-limit responses here.
export async function queryStatusWithRetry(read, { signal, intervalMs = 5000, log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) {
      error.stage = 'preflight';
      const transient = ['API_NETWORK_ERROR', 'API_TIMEOUT', 'STATUS_REQUEST_FAILED', 'STATUS_REQUEST_TIMEOUT'].includes(error.code)
        || (error.httpStatus >= 500 && error.httpStatus < 600);
      if (signal?.aborted || !transient || attempt >= 3) throw error;
      const delayMs = Math.min(intervalMs * 2 ** (attempt - 1), 30000);
      log('status_query_retry', { stage: 'preflight', code: error.code, delayMs });
      await delay(delayMs, undefined, { signal });
    }
  }
}
