import pino from 'pino';
import { loggingAls } from './als';

/**
 * Maps pino numeric levels to GCP Cloud Logging severity strings.
 * Cloud Error Reporting auto-detects severity >= ERROR.
 */
function toGcpSeverity(label: string): string {
  switch (label) {
    case 'trace':
    case 'debug':
      return 'DEBUG';
    case 'info':
      return 'INFO';
    case 'warn':
      return 'WARNING';
    case 'error':
      return 'ERROR';
    case 'fatal':
      return 'CRITICAL';
    default:
      return 'DEFAULT';
  }
}

const usePretty = process.env.LOG_PRETTY === 'true';

const transport = usePretty
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
  : undefined;

export const logger = pino(
  {
    messageKey: 'message',
    formatters: {
      level(label: string) {
        return { severity: toGcpSeverity(label) };
      },
    },
    mixin() {
      const store = loggingAls.getStore();
      if (!store) return {};
      const ctx: Record<string, string> = { traceId: store.traceId };
      if (store.workerId !== undefined) ctx.workerId = store.workerId;
      if (store.jobPostingId !== undefined) ctx.jobPostingId = store.jobPostingId;
      if (store.batchId !== undefined) ctx.batchId = store.batchId;
      return ctx;
    },
  },
  transport,
);
