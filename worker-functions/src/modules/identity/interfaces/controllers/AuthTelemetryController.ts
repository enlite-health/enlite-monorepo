import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';

const LOG = '[ADMIN-AUTH-TRACE]';

/**
 * Sink de telemetria do login administrativo.
 *
 * O frontend envia, ao final de cada tentativa de login, a trilha completa de
 * etapas (sign-in Firebase → checagem de domínio → chamada ao backend →
 * refresh de token → redirect). O backend valida e emite UM registro
 * estruturado por tentativa, que cai no Cloud Logging junto dos logs
 * `[ADMIN-AUTH]` do servidor — correlacionável por `traceId`.
 *
 * Rota montada com `optionalAuth` (aceita com ou sem token) para capturar
 * também as falhas token-less (senha errada, domínio rejeitado com logout),
 * protegida por rate limit. Sem escrita em banco — só log.
 */

const traceStepSchema = z.object({
  step: z.string().max(64),
  elapsedMs: z.number().nonnegative().finite(),
  level: z.enum(['info', 'warn', 'error']),
  data: z.record(z.unknown()).optional(),
});

const authTraceSchema = z.object({
  traceId: z.string().min(1).max(64),
  flow: z.enum(['google', 'password']),
  outcome: z.enum(['success', 'denied', 'error']),
  durationMs: z.number().nonnegative().finite(),
  steps: z.array(traceStepSchema).max(50),
});

export type AuthTracePayload = z.infer<typeof authTraceSchema>;

/** Extrai o uid verificado pelo token (quando presente), tolerando shapes de auth diferentes. */
function verifiedUid(req: Request): string | null {
  const r = req as unknown as {
    user?: { uid?: string };
    authContext?: { userId?: string; uid?: string; user?: { uid?: string } };
  };
  return r.user?.uid ?? r.authContext?.userId ?? r.authContext?.uid ?? r.authContext?.user?.uid ?? null;
}

export class AuthTelemetryController {
  /** POST /api/admin/auth/telemetry */
  logTrace(req: Request, res: Response): void {
    const parsed = authTraceSchema.safeParse(req.body);
    if (!parsed.success) {
      // Payload inválido não é erro do servidor — descarta silenciosamente com 400.
      res.status(400).json({ success: false, error: 'Invalid trace payload' });
      return;
    }

    const trace = parsed.data;
    const uid = verifiedUid(req);
    const log = logger.child({ traceId: trace.traceId });

    const record = {
      msg: `${LOG} ${trace.flow} outcome=${trace.outcome}`,
      source: 'AuthTelemetryController',
      traceId: trace.traceId,
      flow: trace.flow,
      outcome: trace.outcome,
      durationMs: trace.durationMs,
      verifiedUid: uid,
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
      steps: trace.steps,
    };

    // success → info; denied/error → warn (falha de login do cliente, não fault do servidor).
    if (trace.outcome === 'success') {
      log.info(record);
    } else {
      log.warn(record);
    }

    res.status(204).end();
  }
}
