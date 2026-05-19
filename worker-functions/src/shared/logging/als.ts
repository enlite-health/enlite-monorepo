import { AsyncLocalStorage } from 'async_hooks';

export interface LogContext {
  traceId: string;
  workerId?: string;
  jobPostingId?: string;
  batchId?: string;
}

export const loggingAls = new AsyncLocalStorage<LogContext>();
