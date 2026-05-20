import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { McpAuditEvent } from '../../domain/McpAuditEvent';
import { McpCapabilityNotAllowedError } from '../../domain/McpErrors';

interface AuditEmitter {
  emit(event: McpAuditEvent): void;
}

interface Options {
  auditor: AuditEmitter;
  capability: string;
}

export function requireCapability({ auditor, capability }: Options): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const principal = req.servicePrincipal;
    if (!principal) {
      // requireServicePrincipal deveria ter rodado antes; defensiva
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!principal.isCapabilityAllowed(capability)) {
      const err = new McpCapabilityNotAllowedError(principal.name, capability);
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: principal.name,
        onBehalfOfWorkerId: req.onBehalfOfWorkerId ?? null,
        capability,
        argsRedacted: {},
        outcome: 'error',
        errorCode: 'CAPABILITY_NOT_ALLOWED',
        errorMessage: err.message,
        latencyMs: Date.now() - start,
      });
      res.status(403).json({ error: err.message });
      return;
    }
    next();
  };
}
