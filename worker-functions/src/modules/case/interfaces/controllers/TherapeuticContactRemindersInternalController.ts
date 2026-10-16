import { Request, Response } from 'express';
import { z } from 'zod';
import { logger, reportError } from '@shared/logging';
import { SweepTherapeuticContactRemindersUseCase } from '../../application/SweepTherapeuticContactRemindersUseCase';

/** `limit`: ciclos por chamada (default 50 — o Scheduler roda 1×/dia e a fila é pequena). */
const SweepQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional().default(50),
});

/**
 * POST /api/internal/therapeutic-projects/contact-reminders/sweep (spec 048) — chamado pelo Cloud Scheduler, atrás de
 * `internalAuthMiddleware` (X-Internal-Secret) no `app.use`. Devolve SÓ contagens; erro dentro de um ciclo não derruba a
 * resposta (o use case isola e conta em `failed`). Log sem PII.
 */
export class TherapeuticContactRemindersInternalController {
  constructor(private readonly sweep: SweepTherapeuticContactRemindersUseCase = new SweepTherapeuticContactRemindersUseCase()) {}

  async handle(req: Request, res: Response): Promise<void> {
    const parsed = SweepQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors.map((e) => e.message).join('; ') });
      return;
    }
    try {
      const result = await this.sweep.execute({ limit: parsed.data.limit });
      logger.info({ msg: '[pt-contact-reminders/sweep] done', ...result });
      res.status(200).json(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      reportError(error, { source: 'TherapeuticContactRemindersInternalController:handle' });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
