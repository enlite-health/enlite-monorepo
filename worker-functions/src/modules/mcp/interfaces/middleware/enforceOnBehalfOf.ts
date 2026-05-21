import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { McpAuditEvent } from '../../domain/McpAuditEvent';
import { McpOnBehalfOfMismatchError } from '../../domain/McpErrors';

interface AuditEmitter {
  emit(event: McpAuditEvent): void;
}

interface Options {
  auditor: AuditEmitter;
  /** Onde ler o workerId pra comparar com o header */
  source: 'params' | 'body';
  /** Nome do campo no params/body. Default: 'workerId' */
  field?: string;
  /** Nome do header. Default: 'x-on-behalf-of-worker-id' */
  headerName?: string;
}

export function enforceOnBehalfOf({
  auditor,
  source,
  field = 'workerId',
  headerName = 'x-on-behalf-of-worker-id',
}: Options): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const headerValue = req.header(headerName);
    if (!headerValue || typeof headerValue !== 'string' || headerValue.trim() === '') {
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: req.servicePrincipal?.name ?? 'unknown',
        onBehalfOfWorkerId: null,
        capability: 'auth.on_behalf_of',
        argsRedacted: {},
        outcome: 'error',
        errorCode: 'MISSING_HEADER',
        errorMessage: `${headerName} header required`,
        latencyMs: Date.now() - start,
      });
      res.status(400).json({ error: `${headerName} header required` });
      return;
    }

    const argWorkerId =
      source === 'params'
        ? (req.params as Record<string, string | undefined>)[field]
        : (req.body as Record<string, unknown> | undefined)?.[field];

    if (!argWorkerId || typeof argWorkerId !== 'string') {
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: req.servicePrincipal?.name ?? 'unknown',
        onBehalfOfWorkerId: headerValue,
        capability: 'auth.on_behalf_of',
        argsRedacted: {},
        outcome: 'error',
        errorCode: 'MISSING_WORKER_ID',
        errorMessage: `workerId required in ${source}.${field}`,
        latencyMs: Date.now() - start,
      });
      res.status(400).json({ error: `workerId required in ${source}.${field}` });
      return;
    }

    if (argWorkerId !== headerValue) {
      const err = new McpOnBehalfOfMismatchError();
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: req.servicePrincipal?.name ?? 'unknown',
        onBehalfOfWorkerId: headerValue,
        capability: 'auth.on_behalf_of',
        argsRedacted: { argWorkerId },
        outcome: 'error',
        errorCode: 'ON_BEHALF_OF_MISMATCH',
        errorMessage: err.message,
        latencyMs: Date.now() - start,
      });
      res.status(400).json({ error: err.message });
      return;
    }

    req.onBehalfOfWorkerId = headerValue;
    next();
  };
}
