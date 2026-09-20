import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import {
  BlockedApplicationQueryRepository,
} from '../../infrastructure/BlockedApplicationQueryRepository';
import { BLOCKED_ATTEMPT_LIVE_STATES } from '../../infrastructure/blockedAttemptLiveState';
import {
  parsePaginationOptions,
} from '@shared/utils/pagination';

const ListBlockedAttemptsSchema = z.object({
  jobPostingId: z.string().uuid().optional(),
  workerId:     z.string().uuid().optional(),
  // Derivado da fonte única, NÃO reescrito à mão: o motivo passou a ser recalculado
  // na leitura e ganhou o estado `eligible`. Com a lista duplicada aqui, o agregado
  // reportava um balde que o filtro do painel recusava com 400 — a pessoa clicava em
  // "Registro completo" e levava erro. Enum novo entra sozinho a partir de agora.
  reason:       z.enum(BLOCKED_ATTEMPT_LIVE_STATES).optional(),
  page:         z.string().optional(),
  limit:        z.string().optional(),
});

/**
 * RecruitmentBlockedController
 *
 * Endpoints de leitura de tentativas de postulação bloqueadas.
 * Extraído de RecruitmentController para respeitar o limite de 400 linhas.
 *
 * - GET /api/admin/recruitment/blocked-attempts
 *
 * Auth: requireStaff — nunca expõe nome do worker (PII/KMS).
 * Retorna apenas workerId; o frontend resolve o nome via endpoint de worker.
 *
 * Migration 209.
 */
export class RecruitmentBlockedController {
  private readonly queryRepo: BlockedApplicationQueryRepository;

  constructor() {
    this.queryRepo = new BlockedApplicationQueryRepository();
  }

  /**
   * GET /api/admin/recruitment/blocked-attempts
   *
   * Query params:
   *   jobPostingId?  UUID — filtrar por vaga
   *   workerId?      UUID — filtrar por worker
   *   reason?        'worker_not_found' | 'registration_incomplete' | 'worker_disabled'
   *   page?          número da página (padrão 1)
   *   limit?         itens por página (padrão 50, máx 100)
   *
   * Response: { data, aggregates, pagination }
   */
  async listBlockedAttempts(req: Request, res: Response): Promise<void> {
    try {
      const parsed = ListBlockedAttemptsSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: parsed.error.errors.map(e => e.message).join('; '),
        });
        return;
      }

      const { jobPostingId, workerId, reason } = parsed.data;

      const pagination = parsePaginationOptions(req.query);
      const offset = (pagination.page - 1) * pagination.limit;

      const [listResult, aggregates] = await Promise.all([
        this.queryRepo.list({
          jobPostingId,
          workerId,
          reason,
          limit: pagination.limit,
          offset,
        }),
        this.queryRepo.aggregates(),
      ]);

      res.status(200).json({
        success: true,
        data: listResult.data,
        aggregates,
        pagination: {
          total: listResult.total,
          limit: pagination.limit,
          offset,
          page: pagination.page,
          totalPages: Math.ceil(listResult.total / pagination.limit),
          hasNext: offset + listResult.data.length < listResult.total,
          hasPrev: pagination.page > 1,
        },
      });
    } catch (err) {
      logger.warn({
        msg: 'RecruitmentBlockedController.listBlockedAttempts: error',
        error: err instanceof Error ? err.message : String(err),
      });

      const msg = (err instanceof Error ? err.message : '').toLowerCase();
      if (msg.includes('page') || msg.includes('limit')) {
        res.status(400).json({ success: false, error: (err as Error).message });
        return;
      }
      res.status(500).json({ success: false, error: 'Failed to fetch blocked attempts' });
    }
  }
}
