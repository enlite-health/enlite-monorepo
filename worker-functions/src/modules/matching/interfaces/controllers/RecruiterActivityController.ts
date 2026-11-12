import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  GetRecruiterActivityPerPersonUseCase,
  ACTIVITY_WEEKS_MIN,
  ACTIVITY_WEEKS_MAX,
  ACTIVITY_WEEKS_DEFAULT,
} from '../../application/GetRecruiterActivityPerPersonUseCase';

const QuerySchema = z.object({
  weeks: z.coerce.number().int().min(ACTIVITY_WEEKS_MIN).max(ACTIVITY_WEEKS_MAX).default(ACTIVITY_WEEKS_DEFAULT),
});

/**
 * GET /api/admin/recruitment/activity-per-person?weeks=1..12 (default 4)
 *
 * Só contagens por recrutadora (uid opaco) e semana. Célula `recruitment_activity_per_person:read`
 * (Acesso Master). Sem e-mail, nome, worker_id. Controller fino: valida, delega, serializa.
 */
export class RecruiterActivityController {
  constructor(
    private readonly useCase: Pick<GetRecruiterActivityPerPersonUseCase, 'execute'> = new GetRecruiterActivityPerPersonUseCase(
      DatabaseConnection.getInstance().getPool(),
    ),
  ) {}

  async list(req: Request, res: Response): Promise<void> {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: `weeks deve ser um inteiro entre ${ACTIVITY_WEEKS_MIN} e ${ACTIVITY_WEEKS_MAX}`,
      });
      return;
    }
    try {
      const result = await this.useCase.execute({ weeks: parsed.data.weeks });
      res.status(200).json({ success: true, weeks: result.weeks, rows: result.rows });
    } catch (err) {
      logger.warn({
        msg: 'RecruiterActivityController.list: error',
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
