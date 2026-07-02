import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ServicePrincipal } from '../../domain/ServicePrincipal';
import { McpAuthError } from '../../domain/McpErrors';
import { capabilitiesForScopes } from '../../domain/OAuthScopes';
import { logger } from '../../../../shared/logging/Logger';
import type { McpAuditEvent } from '../../domain/McpAuditEvent';

interface TokenRepo {
  findByToken(token: string): Promise<ServicePrincipal | null>;
}

interface AuditEmitter {
  emit(event: McpAuditEvent): void;
}

/** Slim do OAuthTokenVerifier do SDK MCP (evita acoplar o middleware ao SDK). */
export interface OAuthAccessTokenVerifier {
  verifyAccessToken(token: string): Promise<{
    scopes: string[];
    extra?: Record<string, unknown>;
  }>;
}

interface Options {
  repo: TokenRepo;
  auditor: AuditEmitter;
  /** Presente quando o fluxo OAuth do conector claude.ai está habilitado. */
  oauthVerifier?: OAuthAccessTokenVerifier;
  /** URL RFC 9728 anunciada no WWW-Authenticate dos 401 (descoberta do claude.ai). */
  resourceMetadataUrl?: string;
}

export function requireServicePrincipal({
  repo,
  auditor,
  oauthVerifier,
  resourceMetadataUrl,
}: Options): RequestHandler {
  const setChallenge = (res: Response): void => {
    if (resourceMetadataUrl) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl}"`,
      );
    }
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const start = Date.now();
    let authMethod: 'auth.bearer' | 'auth.oauth' = 'auth.bearer';
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new McpAuthError('Missing or malformed Authorization header');
      }
      const token = authHeader.slice('Bearer '.length).trim();
      if (!token) {
        throw new McpAuthError('Empty bearer token');
      }

      let principal: ServicePrincipal | null;
      if (oauthVerifier && looksLikeJwt(token)) {
        authMethod = 'auth.oauth';
        principal = await resolveOAuthPrincipal(oauthVerifier, token);
      } else {
        principal = await repo.findByToken(token);
      }
      if (!principal) {
        throw new McpAuthError('Invalid bearer token');
      }

      req.servicePrincipal = principal;
      auditor.emit({
        timestamp: new Date().toISOString(),
        principal: principal.name,
        onBehalfOfWorkerId: null,
        capability: authMethod,
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
        capability: authMethod,
        argsRedacted: {},
        outcome: 'error',
        errorCode: isAuthErr ? 'AUTH_FAILED' : 'INTERNAL',
        errorMessage: err instanceof Error ? err.message : 'unknown',
        latencyMs: Date.now() - start,
      });
      if (!isAuthErr) {
        logger.error({ err }, 'mcp: unexpected error in requireServicePrincipal');
      }
      setChallenge(res);
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

/** Tokens de service principal são hex opacos; access tokens OAuth são JWTs. */
function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3;
}

/**
 * Converte um access token OAuth num ServicePrincipal sintético read-only.
 * As capabilities vêm do escopo do token (OAuthScopes), então o registry
 * escopado por principal já limita o tools/list automaticamente.
 */
async function resolveOAuthPrincipal(
  verifier: OAuthAccessTokenVerifier,
  token: string,
): Promise<ServicePrincipal | null> {
  let authInfo: Awaited<ReturnType<OAuthAccessTokenVerifier['verifyAccessToken']>>;
  try {
    authInfo = await verifier.verifyAccessToken(token);
  } catch {
    return null;
  }
  const email = typeof authInfo.extra?.email === 'string' ? authInfo.extra.email : 'unknown';
  const capabilities = capabilitiesForScopes(authInfo.scopes);
  if (capabilities.length === 0) {
    return null;
  }
  return new ServicePrincipal({
    name: `claude-ai:${email}`,
    allowedCapabilities: capabilities,
    tokenHashes: ['oauth-access-token'], // não usado nesse caminho; exigido pelo domínio
  });
}
