/**
 * Guard das rotas de aparelho (`/v1/workers/:workerId/device*`): serviço a serviço, FAIL-CLOSED (spec 077, D795).
 *
 * Só Bearer OIDC: audience = `CLOUD_RUN_SERVICE_URL` (verificada pelo Google), `email_verified` e e-mail na allowlist
 * `WORKER_DEVICE_ALLOWED_SAS` (lista separada por vírgula; hoje a SA do mobile-bff). Allowlist vazia/ausente → 403 sempre.
 * Token de usuário final (Firebase) não passa: a verificação OIDC o recusa. O serviço é interno; o `triage-service` é que é público.
 * Mesma forma de `requirePersonTreeService` (verify → email_verified → allowlist), sem o `X-Internal-Secret`.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '@shared/logging';

export const WORKER_DEVICE_ALLOWLIST_ENV = 'WORKER_DEVICE_ALLOWED_SAS';

export function readWorkerDeviceAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[WORKER_DEVICE_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const client = new OAuth2Client();

export const requireWorkerDeviceService: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && header.length > 7) {
    const allowlist = readWorkerDeviceAllowlist();
    if (allowlist.length > 0) {
      try {
        const ticket = await client.verifyIdToken({ idToken: header.slice(7), audience: process.env.CLOUD_RUN_SERVICE_URL });
        const payload = ticket.getPayload();
        if (payload?.email_verified === true && payload.email && allowlist.includes(payload.email)) return next();
      } catch (err) {
        // só o nome do erro: a mensagem do verificador pode ecoar o token
        logger.warn({ error: err instanceof Error ? err.name : 'error' }, '[worker-device] verificação OIDC falhou');
      }
    }
  }
  res.status(403).json({ error: 'Forbidden' });
};
