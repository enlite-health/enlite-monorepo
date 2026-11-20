import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import { ClaimController } from '../controllers/ClaimController';
import type { AuthMiddleware } from '@modules/identity/interfaces/middleware/AuthMiddleware';
import { routeClass } from '@modules/identity/permissions';
import { profileEditChannelOf } from '@modules/worker/interfaces/middleware/appChannel';
import { APP_CHANNEL } from '@modules/worker/domain/profileEditSource';

/**
 * Chave por IP (com X-Forwarded-For como preferência) normalizada por
 * `ipKeyGenerator`: em IPv6 cada cliente tem um /64 (às vezes /56) inteiro à
 * disposição, então chavear pelo endereço exato deixa a mesma pessoa trocar
 * de sufixo e furar o limite de OTP/confirm. Extraída (e exportada) para ser
 * testável isoladamente — `express-rate-limit` não expõe o `keyGenerator` no
 * handler montado.
 */
export function claimIpKey(req: Request): string {
  return ipKeyGenerator(
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown',
  );
}

/** Limitador de OTP: janela de 15 min, chave `claimIpKey`. Uma definição para claim e init. */
function otpRateLimit(max: number, error: string, extra: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: claimIpKey,
    message: { success: false, error },
    ...extra,
  });
}

const OTP_START_LIMIT = 3;
const OTP_START_ERROR = 'Too many OTP requests. Try again in 15 minutes.';

/**
 * Rate limit para claim/start:
 *   Max 3 tentativas por IP em 15 minutos.
 *   Impede enumeração de números válidos e abuso do Twilio Verify.
 */
const claimStartRateLimit = otpRateLimit(OTP_START_LIMIT, OTP_START_ERROR);

/**
 * Rate limit para claim/confirm:
 *   Max 5 tentativas por IP em 15 minutos (acomoda typos do usuário).
 */
const claimConfirmRateLimit = otpRateLimit(5, 'Too many confirmation attempts. Try again in 15 minutes.');

/** Quem dispara OTP fora das rotas de claim marca a resposta, e só ela conta no limite do init. */
export function markOtpStarted(res: Response): void {
  res.locals = Object.assign(res.locals ?? {}, { otpStarted: true });
}

/**
 * Chave da cota do init. Canal app (token de serviço da mobile-bff-sa JÁ validado pelo `appChannel`):
 * `app:<uid do JWT>`, porque pelo BFF o IP é o de saída do Cloud Run, comum a todas as cuidadoras, e a cota
 * por IP viraria global. Web (sem marca): `ip:<claimIpKey>`, como o claim/start. Sem uid no canal app, volta ao IP.
 */
export function initOtpKey(req: Request, res: Response): string {
  const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
  if (profileEditChannelOf(res) === APP_CHANNEL && uid) return `app:${uid}`;
  return `ip:${claimIpKey(req)}`;
}

/**
 * Rate limit do `POST /api/workers/init` (DP-20): o init dispara SMS ao telefone da ficha
 * (`claim_pending`), pelo ramo de telefone e pelo de e-mail não verificado. Mesmo limite do
 * claim/start (3 em 15 min), contando SÓ a resposta que abriu OTP (`markOtpStarted`): o init sem
 * SMS (login, cadastro novo) não gasta a cota. Com a cota cheia, a próxima chamada leva 429 antes
 * do use case, sem novo envio. Chave: `initOtpKey` (uid no canal app, IP na web).
 * ⚠️ Monta DEPOIS de `requireAuth` e `appChannel` (precisa do uid e da marca do canal): o anônimo
 * leva 401 do `requireAuth` antes de qualquer use case/Twilio.
 */
export function createWorkerInitOtpRateLimit() {
  return otpRateLimit(OTP_START_LIMIT, OTP_START_ERROR, {
    keyGenerator: initOtpKey,
    skipSuccessfulRequests: true,
    // "bem-sucedida" aqui = não abriu OTP → é descontada da cota
    requestWasSuccessful: (_req, res) => res.locals?.otpStarted !== true,
  });
}

export function createClaimRoutes(controller: ClaimController, authMiddleware: AuthMiddleware): Router {
  const router = Router();

  // H3 (D650): as duas rotas exigem token e usam só o uid/email DELE. A ordem importa:
  // rate limit primeiro (barato, por IP, segura rajada anônima) e `requireAuth` depois.
  // O usuário pode ainda não ter worker — `requireAuth` só valida o token, não exige ficha.
  router.post(
    '/auth/claim/start',
    routeClass('client-policy'),
    claimStartRateLimit,
    authMiddleware.requireAuth(),
    (req: Request, res: Response) => controller.start(req, res),
  );

  router.post(
    '/auth/claim/confirm',
    routeClass('client-policy'),
    claimConfirmRateLimit,
    authMiddleware.requireAuth(),
    (req: Request, res: Response) => controller.confirm(req, res),
  );

  return router;
}
