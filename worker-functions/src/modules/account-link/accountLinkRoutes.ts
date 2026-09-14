/**
 * accountLinkRoutes — rotas do vínculo self-service.
 *
 * Flag ACCOUNT_LINK_ENABLED (checada POR REQUEST): OFF → 404 em tudo, prod
 * neutro — o front trata 404 como "fluxo não existe" e mantém o toast atual.
 *
 * Rate-limits por IP (mesma régua do claim, que já protege o Twilio) além do
 * limite por conta (3 starts/h) checado no service via account_link_events.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { AccountLinkController } from './AccountLinkController';
import type { AuthMiddleware } from '../identity/interfaces/middleware/AuthMiddleware';

function flagGate(req: Request, res: Response, next: NextFunction): void {
  if (process.env.ACCOUNT_LINK_ENABLED !== 'true') {
    res.status(404).json({ success: false, error: 'Not found' });
    return;
  }
  next();
}

// `ipKeyGenerator` e não o endereço cru: em IPv6 cada cliente recebe um /64
// (às vezes /56) inteiro, então chave por endereço exato deixa a mesma pessoa
// trocar de sufixo e furar o limite de start/confirm. Exportada para teste.
export const ipKey = (req: Request): string =>
  ipKeyGenerator(
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? 'unknown',
  );

const startIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: ipKey,
  message: { success: false, code: 'RATE_LIMITED', error: 'Too many OTP requests. Try again later.' },
});

const confirmIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  keyGenerator: ipKey,
  message: { success: false, code: 'RATE_LIMITED', error: 'Too many attempts. Try again later.' },
});

export function createAccountLinkRoutes(
  controller: AccountLinkController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const auth = [authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'update')];

  router.post('/workers/me/account-link/lookup', flagGate, ...auth,
    (req: Request, res: Response) => void controller.lookup(req, res));

  router.post('/workers/me/account-link/start', flagGate, startIpLimit, ...auth,
    (req: Request, res: Response) => void controller.start(req, res));

  router.post('/workers/me/account-link/confirm', flagGate, confirmIpLimit, ...auth,
    (req: Request, res: Response) => void controller.confirm(req, res));

  router.post('/workers/me/account-link/finalize', flagGate, ...auth,
    (req: Request, res: Response) => void controller.finalize(req, res));

  // Undo do email: SEM auth de sessão — a credencial é o token assinado (a
  // pessoa que recebeu o aviso pode nem ter mais login funcional).
  router.get('/account-link/undo/:token', flagGate,
    (req: Request, res: Response) => controller.undoPage(req, res));
  router.post('/account-link/undo/:token', flagGate,
    (req: Request, res: Response) => void controller.undoExecute(req, res));

  return router;
}
