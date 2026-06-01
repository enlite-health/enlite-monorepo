import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ClaimController } from '../controllers/ClaimController';

/**
 * Rate limit para claim/start:
 *   Max 3 tentativas por IP em 15 minutos.
 *   Impede enumeração de números válidos e abuso do Twilio Verify.
 */
const claimStartRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.ip ??
    'unknown',
  message: { success: false, error: 'Too many OTP requests. Try again in 15 minutes.' },
});

/**
 * Rate limit para claim/confirm:
 *   Max 5 tentativas por IP em 15 minutos (acomoda typos do usuário).
 */
const claimConfirmRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.ip ??
    'unknown',
  message: { success: false, error: 'Too many confirmation attempts. Try again in 15 minutes.' },
});

export function createClaimRoutes(controller: ClaimController): Router {
  const router = Router();

  // authMiddleware.requireAuth() é deliberadamente omitido aqui:
  // o usuário pode não ter um worker ainda — o token Firebase é validado
  // implicitamente pelo authUid no body (mesma estratégia de /api/workers/init).
  // Se o projeto exigir auth middleware no futuro, adicionar aqui.
  router.post(
    '/auth/claim/start',
    claimStartRateLimit,
    (req: Request, res: Response) => controller.start(req, res),
  );

  router.post(
    '/auth/claim/confirm',
    claimConfirmRateLimit,
    (req: Request, res: Response) => controller.confirm(req, res),
  );

  return router;
}
