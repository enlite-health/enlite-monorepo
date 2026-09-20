/**
 * PromoteBlockedApplicationController
 *
 * POST /api/admin/vacancies/blocked-applications/:blockedId/promote
 *
 * O botão "Promover" do card ELEGIBLE (D300). Transforma a tentativa bloqueada em
 * candidatura real — a mesma coisa que a varredura automática faria, com as MESMAS
 * guardas, só que a pedido de uma pessoa do time e sobre um card só.
 *
 * Por que o botão existe: a promoção automática só dispara no evento
 * `worker.registration_completed`. Quem virou REGISTERED por outro caminho (edição
 * do staff, importação, merge, reativação por atividade) nunca gera esse evento e
 * fica parado na coluna vermelha para sempre. Medido em produção em 08/09/2026:
 * **90 cards abertos de gente elegível naquele momento**.
 *
 * Controller sem regra de negócio, por `worker-functions/CLAUDE.md`: valida a
 * entrada, delega ao use case e traduz o resultado para HTTP.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { staffActor } from '@shared/audit/actorSource';
import { PromoteBlockedApplicationsUseCase } from '../../application/PromoteBlockedApplicationsUseCase';

/**
 * Guardas que recusam a promoção mapeadas para HTTP.
 *
 * 409 e não 500: nenhuma delas é falha nossa — são estados legítimos do mundo que
 * mudaram entre a tela ter sido carregada e o clique acontecer. A tela precisa
 * distinguir "deu errado" de "não vale mais", e o corpo carrega qual foi.
 */
const CONFLICT_REASONS = ['worker_not_eligible', 'vacancy_invalid', 'wja_already_exists', 'unique_conflict', 'worker_opted_out'];

export class PromoteBlockedApplicationController {
  private readonly useCase: PromoteBlockedApplicationsUseCase;

  constructor(useCase?: PromoteBlockedApplicationsUseCase) {
    this.useCase = useCase ?? new PromoteBlockedApplicationsUseCase();
  }

  async promote(req: Request, res: Response): Promise<void> {
    try {
      const { blockedId } = req.params;
      if (!blockedId || !z.string().uuid().safeParse(blockedId).success) {
        res.status(400).json({ success: false, error: 'blockedId must be a valid UUID' });
        return;
      }

      const uid = ((req as any).user as { uid?: string } | undefined)?.uid;
      const result = await this.useCase.executeForBlockedApplication(
        blockedId,
        staffActor(uid) ?? undefined,
      );

      if (result === null) {
        res.status(404).json({ success: false, error: 'Blocked application not found or already promoted' });
        return;
      }

      if (result.promoted === 0) {
        const reason = Object.keys(result.reasons)[0] ?? 'unknown';
        const status = CONFLICT_REASONS.includes(reason) ? 409 : 500;
        // `code` e `reason` NÃO são redundância: `ApiError` do frontend só popula
        // esses dois campos, e a tela escolhe a frase por eles. Sem isto, todo 409
        // caía no `defaultValue` e a recrutadora lia "Tente de novo" — inclusive no
        // caso de opt-out, onde repetir é exatamente o que ela NÃO deve fazer.
        // Mesmo formato da rota irmã do funil (WJAFunnelController).
        res.status(status).json({
          success: false,
          error: reason,
          code: reason,
          reason,
          data: { blockedId, reasons: result.reasons },
        });
        return;
      }

      res.json({ success: true, data: { blockedId, promoted: result.promoted } });
    } catch (error) {
      // O ORIGINAL só para o servidor. O corpo devolve código genérico porque a
      // tela joga a falha num `console.error` do navegador, e produção roda
      // Microsoft Clarity — mensagem de erro do driver pode arrastar contexto da
      // linha para uma ferramenta de terceiro. (Parecer `lex`, 08/09.)
      reportError(error instanceof Error ? error : new Error(String(error)), {
        source: 'PromoteBlockedApplicationController.promote',
      });
      res.status(500).json({ success: false, error: 'promote_failed' });
    }
  }
}
