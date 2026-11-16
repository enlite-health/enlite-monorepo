import { Request, Response, NextFunction } from 'express';
import { logger } from '@shared/logging';
import {
  MOBILE_BFF_AUDIENCE,
  ServiceIdentityVerifier,
  createServiceIdentityVerifier,
  readServiceAllowlist,
} from '@modules/agentes/infrastructure/ServiceIdentityVerifier';
import { APP_CHANNEL } from '../../domain/profileEditSource';

/** Header com o Google ID token da mobile-bff-sa (DT-13), sem prefixo Bearer. */
export const APP_SERVICE_TOKEN_HEADER = 'x-enlite-service-token';
/** Conta de serviço do BFF do app (terraform/environments/prd/attendance_services.tf). */
export const MOBILE_BFF_ACCOUNT_ID = 'mobile-bff-sa';

/** Canal marcado pelo appChannel nesta request; undefined = sem marca (o use case usa o default da fonte). */
export function profileEditChannelOf(res: Response): string | undefined {
  return res.locals?.profileEditChannel;
}

/** `code` estável do 401 (mesmo padrão `{ success, error, code }` do WORKER_NOT_REGISTERED); o BFF traduz o code, não o texto. */
export const INVALID_SERVICE_TOKEN_CODE = 'INVALID_SERVICE_TOKEN';

/**
 * Marca a request como canal app só com token válido da mobile-bff-sa (A-02).
 * Fail-closed (D734): header ausente = caminho da web, segue sem marca; header PRESENTE que não valida
 * (token recusado, outra SA, e-mail não verificado, allowlist vazia) = 401 INVALID_SERVICE_TOKEN. Sem isso
 * quem declara ser o app e falha cairia no caminho da web, que cria ficha.
 */
export function appChannel(injectedVerifier?: ServiceIdentityVerifier) {
  let fallback: ServiceIdentityVerifier | undefined;
  const recusa = (res: Response) =>
    void res.status(401).json({ success: false, error: 'Invalid service token', code: INVALID_SERVICE_TOKEN_CODE });
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.headers[APP_SERVICE_TOKEN_HEADER];
    if (raw === undefined) {
      next();
      return;
    }
    const token = Array.isArray(raw) ? raw[0] : raw;
    try {
      const verifier = injectedVerifier ?? (fallback ??= createServiceIdentityVerifier(undefined, process.env, MOBILE_BFF_AUDIENCE));
      const payload = token ? await verifier.verify(token) : undefined;
      if (payload?.email_verified === true && !!payload.email && readServiceAllowlist(process.env, MOBILE_BFF_ACCOUNT_ID).includes(payload.email)) {
        res.locals.profileEditChannel = APP_CHANNEL;
        next();
        return;
      }
      logger.warn({ reason: 'not_allowed' }, '[appChannel] service token rejected');
    } catch (err) {
      // Só o nome do erro: a mensagem do verificador pode ecoar o token.
      logger.warn({ error: err instanceof Error ? err.name : 'error' }, '[appChannel] service token verification failed');
    }
    recusa(res);
  };
}
