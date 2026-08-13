import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthTelemetryController } from '../controllers/AuthTelemetryController';
import { AuthMiddleware } from '../middleware/AuthMiddleware';

/**
 * Telemetria do login administrativo — POST /api/admin/auth/telemetry.
 *
 * `optionalAuth` para capturar também falhas token-less (senha errada,
 * domínio rejeitado com logout); rate limit para não virar sink aberto de logs.
 */
export function createAuthTelemetryRoutes(authMiddleware: AuthMiddleware): Router {
  const router = Router();
  const controller = new AuthTelemetryController();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests' },
  });

  router.post(
    '/admin/auth/telemetry',
    limiter,
    authMiddleware.optionalAuth(),
    (req: Request, res: Response) => controller.logTrace(req, res),
  );

  return router;
}
