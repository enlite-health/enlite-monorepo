import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ServicePrincipal } from '../../domain/ServicePrincipal';
import { McpAuthError } from '../../domain/McpErrors';
import { logger } from '../../../../shared/logging/Logger';
import type { McpAuditEvent } from '../../domain/McpAuditEvent';

interface TokenRepo {
  findByToken(token: string): Promise<ServicePrincipal | null>;
}

interface AuditEmitter {
  emit(event: McpAuditEvent): void;
}

interface Options {
  repo: TokenRepo;
  auditor: AuditEmitter;
}

export function requireServicePrincipal({ repo, auditor }: Options): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const start = Date.now();
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new McpAuthError('Missing or malformed Authorization header');
      }
      const token = authHeader.slice('Bearer '.length).trim();
      if (!token) {
        throw new McpAuthError('Empty bearer token');
      }
      const principal = await repo.findByToken(token);
      if (!principal) {
        throw new McpAuthError('Invalid bearer token');
      }
      req.servicePrincipal = principal;
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: principal.name,
        onBehalfOfWorkerId: null,
        capability: 'auth.bearer',
        argsRedacted: {},
        outcome: 'success',
        latencyMs: Date.now() - start,
      });
      next();
    } catch (err) {
      const isAuthErr = err instanceof McpAuthError;
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: 'unknown',
        onBehalfOfWorkerId: null,
        capability: 'auth.bearer',
        argsRedacted: {},
        outcome: 'error',
        errorCode: isAuthErr ? 'AUTH_FAILED' : 'INTERNAL',
        errorMessage: err instanceof Error ? err.message : 'unknown',
        latencyMs: Date.now() - start,
      });
      if (!isAuthErr) {
        logger.error({ err }, 'mcp: unexpected error in requireServicePrincipal');
      }
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}
