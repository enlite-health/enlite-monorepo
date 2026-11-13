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

/**
 * Marca a edição de perfil como canal app só com token válido da mobile-bff-sa (A-02).
 * Nunca responde: sem header ou com token inválido segue sem marca (a edição continua platform).
 */
export function appChannel(injectedVerifier?: ServiceIdentityVerifier) {
  let fallback: ServiceIdentityVerifier | undefined;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.headers[APP_SERVICE_TOKEN_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (token) {
      try {
        const verifier = injectedVerifier ?? (fallback ??= createServiceIdentityVerifier(undefined, process.env, MOBILE_BFF_AUDIENCE));
        const payload = await verifier.verify(token);
        if (payload?.email_verified === true && !!payload.email && readServiceAllowlist(process.env, MOBILE_BFF_ACCOUNT_ID).includes(payload.email)) {
          res.locals.profileEditChannel = APP_CHANNEL;
        }
      } catch (err) {
        // Só o nome do erro: a mensagem do verificador pode ecoar o token.
        logger.warn({ error: err instanceof Error ? err.name : 'error' }, '[appChannel] service token verification failed');
      }
    }
    next();
  };
}
