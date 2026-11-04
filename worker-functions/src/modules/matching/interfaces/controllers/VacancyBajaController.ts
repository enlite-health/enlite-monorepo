import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withSystemDbContext } from '@shared/database/requestDbSession';
import { reportError } from '@shared/logging';
import { BajaVacanciesUseCase, BAJA_BATCH_MAX } from '../../application/BajaVacanciesUseCase';
import { VacancyTalentumPauseService, type VacancyBajaSideEffects } from '../../application/VacancyTalentumPauseService';
import { BAJA_REFUSAL_MESSAGES } from '../../domain/VacancyBajaPolicy';
import { vacancyActorFromRequest } from './vacancyCrudAuditHelpers';

const BajaBody = z.object({
  vacancyIds: z.array(z.string().uuid()).min(1).max(BAJA_BATCH_MAX),
});

/**
 * VacancyBajaController — spec 084 F1: `POST /api/admin/vacancies/baja` (uma vaga = lote de 1).
 * Dar baixa NUNCA apaga. Não há rota inversa (R17): vaga baixada só volta pela reativação do serviço.
 * Pós-commit (fire-and-forget): tenta pausar o projeto no Talentum (F4); o que for recusado vira lista manual.
 */
export class VacancyBajaController {
  private readonly db: Pool;

  constructor(
    private readonly useCase: BajaVacanciesUseCase = new BajaVacanciesUseCase(DatabaseConnection.getInstance().getPool()),
    private readonly sideEffects: VacancyBajaSideEffects = new VacancyTalentumPauseService(DatabaseConnection.getInstance().getPool()),
  ) {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async baja(req: Request, res: Response): Promise<void> {
    const parsed = BajaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: `vacancyIds deve ter de 1 a ${BAJA_BATCH_MAX} UUIDs`, details: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const actor = { ...vacancyActorFromRequest(req, 'admin_panel'), actorType: 'HUMAN' as const };
      const outcome = await this.useCase.execute(parsed.data.vacancyIds, 'MANUAL', actor);
      if (!outcome.ok) {
        res.status(409).json({
          success: false,
          code: 'BAJA_REFUSED',
          error: 'Nenhuma vaga foi baixada: o lote tem vagas que não podem receber baixa manual.',
          refused: outcome.refused.map((r) => ({
            vacancyId: r.vacancyId,
            code: r.code,
            messages: r.code === 'VACANCY_NOT_FOUND'
              ? { es: 'Vacante no encontrada.', 'pt-BR': 'Vaga não encontrada.' }
              : BAJA_REFUSAL_MESSAGES[r.code],
          })),
        });
        return;
      }
      const ids = outcome.baixadas.map((b) => b.vacancyId);
      setImmediate(() => {
        void withSystemDbContext('job:vacancy-baja-talentum', async () => {
          try {
            await this.sideEffects.pause(ids);
          } catch (err) {
            reportError(err instanceof Error ? err : new Error(String(err)), { source: 'VacancyBajaController:talentumPause' });
          }
        });
      });
      res.status(200).json({ success: true, data: { baixadas: outcome.baixadas } });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyBajaController:baja' });
      res.status(500).json({ success: false, error: 'Failed to give vacancies de baja', details: msg });
    }
  }
}
