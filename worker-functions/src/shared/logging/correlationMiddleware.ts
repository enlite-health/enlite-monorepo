import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { loggingAls } from './als';

/**
 * Express middleware that extracts the trace ID from the
 * `X-Cloud-Trace-Context` header (format: TRACE_ID/SPAN_ID;o=TRACE_TRUE)
 * and runs the rest of the request inside an AsyncLocalStorage context so
 * that every log line produced downstream automatically carries `traceId`.
 *
 * If the header is absent (Cloud Tasks, Pub/Sub push, internal requests),
 * a random UUID v4 is generated instead.
 */
export function correlationMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const headerValue = req.headers['x-cloud-trace-context'];
  const rawHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  let traceId: string;

  if (rawHeader) {
    // Format: TRACE_ID/SPAN_ID;o=TRACE_TRUE — we only need TRACE_ID
    const slashIndex = rawHeader.indexOf('/');
    traceId = slashIndex !== -1 ? rawHeader.slice(0, slashIndex) : rawHeader;
  } else {
    traceId = uuidv4();
  }

  loggingAls.run({ traceId }, next);
}
