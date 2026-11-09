/**
 * Guard da rota `GET /v1/persons/:pid/tree` (T138): serviço a serviço, FAIL-CLOSED.
 *
 * · `X-Internal-Secret` válido (Cloud Tasks) passa, exatamente como o `internalAuthMiddleware`.
 * · Bearer OIDC: audience = `CLOUD_RUN_SERVICE_URL` (verificada pelo Google), `email_verified` e e-mail na allowlist
 *   `PERSON_TREE_ALLOWED_SAS` (lista separada por vírgula). Allowlist vazia/ausente → OIDC nunca passa (403).
 * Mesma forma de `requireAssistantsService` (verify → email_verified → allowlist), com a lista vinda de env.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '@shared/logging';
import { hasValidInternalSecret } from '@modules/notification/interfaces/middleware/InternalAuthMiddleware';

export const PERSON_TREE_ALLOWLIST_ENV = 'PERSON_TREE_ALLOWED_SAS';

export function readPersonTreeAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[PERSON_TREE_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const client = new OAuth2Client();

export const requirePersonTreeService: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  if (hasValidInternalSecret(req)) return next();

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && header.length > 7) {
    const allowlist = readPersonTreeAllowlist();
    if (allowlist.length > 0) {
      try {
        const ticket = await client.verifyIdToken({
          idToken: header.slice(7),
          audience: process.env.CLOUD_RUN_SERVICE_URL,
        });
        const payload = ticket.getPayload();
        if (payload?.email_verified === true && payload.email && allowlist.includes(payload.email)) return next();
      } catch (err) {
        // só o nome do erro: a mensagem do verificador pode ecoar o token
        logger.warn({ error: err instanceof Error ? err.name : 'error' }, '[persons/tree] verificação OIDC falhou');
      }
    }
  }
  res.status(403).json({ error: 'Forbidden' });
};
