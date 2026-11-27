import { Router, Request, Response } from 'express';
import type { AuthMiddleware } from '@modules/identity/interfaces/middleware/AuthMiddleware';
import { routeClass } from '@modules/identity/permissions';
import { selfUid } from '@shared/http/selfUid';
import type { PhoneVerificationController } from '../controllers/PhoneVerificationController';
import { createPgRateLimitStore } from '@shared/rateLimit/PgRateLimitStore';
import { claimIpKey, otpRateLimit } from './claimRoutes';

/**
 * Celular verificado (emenda 077 §2.4) — `start` dispara WhatsApp e `confirm` testa o código. No plano B de canal (Twilio
 * Verify, `createOtpChallengePort`) não há linha em `otp_challenges`, logo nenhum limite no banco (`TwilioVerifyOtpAdapter`):
 * o limite mora AQUI, com o limitador único de OTP (`otpRateLimit`, janela de 15 min) e a forma do lookup do vínculo:
 *
 *   por IP (ANTES do auth, barato): 30/15 min nas duas rotas — o `LOOKUP_IP_MAX` do vínculo. IP de saída compartilhado
 *     (NAT, BFF do app) não pode virar balde de todo mundo; é a segunda camada, contra fazenda de contas num IP.
 *   por CONTA (uid do token, DEPOIS do auth): start 3/15 min — a cota de OTP do claim/start e do init (`OTP_START_LIMIT`):
 *     envio + 2 reenvios; confirm 5/15 min — o do claim/confirm (acomoda erro de digitação, trava força bruta do código).
 *
 * Bloqueio: 429 `{ success: false, code: 'RATE_LIMITED' }` + `Retry-After` (standardHeaders), sem chegar ao controller.
 * Por IP: store em memória por instância (1ª camada barata, antes do auth): com N instâncias o teto efetivo é até N× o valor.
 * Por CONTA (uid): contado no banco (`PgRateLimitStore`), compartilhado entre instâncias — o teto vale como escrito.
 */
export const PHONE_VERIFICATION_IP_MAX = 30;
export const PHONE_VERIFICATION_START_UID_MAX = 3;
export const PHONE_VERIFICATION_CONFIRM_UID_MAX = 5;

const START_ERROR = 'Too many OTP requests. Try again in 15 minutes.';
const CONFIRM_ERROR = 'Too many confirmation attempts. Try again in 15 minutes.';

const uidKey = (req: Request): string => `uid:${selfUid(req) ?? claimIpKey(req)}`;

/** `uidStorePrefix` presente = limitador por conta (uid), contado no banco com esse prefixo; ausente = por IP, em memória. */
function limit(max: number, error: string, uidStorePrefix?: string) {
  return otpRateLimit(max, error, {
    message: { success: false, code: 'RATE_LIMITED', error },
    ...(uidStorePrefix ? { keyGenerator: uidKey, store: createPgRateLimitStore(uidStorePrefix) } : {}),
  });
}

export function createPhoneVerificationRoutes(
  controller: PhoneVerificationController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const auth = [authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'update')];

  // O servidor decide a finalidade; `confirm` é a única rota que troca um telefone já gravado.
  router.post('/workers/me/phone-verification/start', routeClass('client-policy'),
    limit(PHONE_VERIFICATION_IP_MAX, START_ERROR), ...auth, limit(PHONE_VERIFICATION_START_UID_MAX, START_ERROR, 'pv-start-uid'),
    (req: Request, res: Response) => void controller.start(req, res));

  router.post('/workers/me/phone-verification/confirm', routeClass('client-policy'),
    limit(PHONE_VERIFICATION_IP_MAX, CONFIRM_ERROR), ...auth, limit(PHONE_VERIFICATION_CONFIRM_UID_MAX, CONFIRM_ERROR, 'pv-confirm-uid'),
    (req: Request, res: Response) => void controller.confirm(req, res));

  return router;
}
