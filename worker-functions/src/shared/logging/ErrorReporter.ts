import { logger } from './Logger';

/**
 * Reports an error to Cloud Error Reporting via the structured log format.
 *
 * Cloud Error Reporting auto-detects entries with:
 *   `@type = 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent'`
 *
 * This avoids the `@google-cloud/error-reporting` SDK dependency (DP-001).
 */
export function reportError(
  err: Error,
  context?: Record<string, unknown>,
): void {
  logger.error(
    {
      err,
      stack_trace: err.stack,
      '@type':
        'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      serviceContext: { service: 'worker-functions' },
      ...context,
    },
    err.message,
  );
}
