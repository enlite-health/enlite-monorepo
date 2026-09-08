import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor, type ActorContext } from '@shared/audit/actorSource';
import { logger } from '@shared/logging';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../domain/WorkerApplicationEligibility';
import { CreateManualWjaWithEncuadreUseCase } from './CreateManualWjaWithEncuadreUseCase';

/** Canal neutro usado quando a tentativa bloqueada não tinha acquisition_channel. */
const NEUTRAL_CHANNEL = 'blocked_promotion';

interface BlockedRow {
  id: string;
  job_posting_id: string;
  acquisition_channel: string | null;
}

interface JobPostingGuardRow {
  is_draft: boolean;
  status: string;
}

export interface PromoteBlockedApplicationsOptions {
  /**
   * Promove SÓ esta linha. Ausente = varredura de todas as tentativas do worker,
   * que é o caminho do evento `worker.registration_completed`.
   *
   * Existe porque o botão "Promover" do card age sobre UM card: promover as
   * outras vagas junto seria efeito colateral que a recrutadora não pediu nem vê.
   */
  blockedApplicationId?: string;
  /**
   * Ator da escrita, para a trilha. Ausente = `system:promote-blocked` (a
   * varredura automática). A ação manual passa `staffActor(uid)` — sem isso a
   * trilha registraria como decisão de máquina algo que uma pessoa decidiu.
   */
  actor?: ActorContext;
}

export interface PromoteBlockedApplicationsResult {
  promoted: number;
  skipped: number;
  /** Contagem de skips por motivo — chaves: vacancy_invalid, wja_already_exists,
   *  worker_not_eligible, unique_conflict, error. */
  reasons: Record<string, number>;
}

/**
 * PromoteBlockedApplicationsUseCase
 *
 * Handler de negócio do evento `worker.registration_completed`: quando um
 * worker que tentou postular sem estar REGISTERED completa o cadastro, promove
 * suas tentativas bloqueadas (worker_blocked_applications) para
 * worker_job_applications reais (source='manual', stage='INVITED') — o card
 * sai da coluna BLOQUEADO e entra em INICIADO no Kanban.
 *
 * Guardas por linha (mesma semântica do NOT EXISTS de
 * BlockedApplicationQueryRepository.listByVacancy):
 *   a. vaga existe, deleted_at IS NULL, is_draft=false, status != 'CLOSED'
 *   b. NOT EXISTS worker_job_applications para o par (worker_id, job_posting_id)
 *      em QUALQUER stage — nunca ressuscita um WJA REJECTED (worker que se
 *      re-postulou sozinho e foi rejeitado pelo prescreening Talentum).
 *   c. worker não merged e status='REGISTERED' — reverificado aqui porque o
 *      evento pode chegar atrasado (revalidação contra estado atual, não o
 *      estado no momento em que o evento foi enfileirado).
 *
 * Idempotente: só processa linhas com promoted_at IS NULL; após promover,
 * seta promoted_at + promoted_wja_id. Tolerante: falha em uma linha não
 * impede as outras (try/catch por linha); conflitos de UNIQUE (corrida entre
 * o NOT EXISTS e o INSERT) viram skip, nunca erro propagado.
 */
export class PromoteBlockedApplicationsUseCase {
  private readonly pool: Pool;
  private readonly createWjaUseCase: CreateManualWjaWithEncuadreUseCase;

  constructor(pool?: Pool, createWjaUseCase?: CreateManualWjaWithEncuadreUseCase) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.createWjaUseCase = createWjaUseCase ?? new CreateManualWjaWithEncuadreUseCase();
  }

  /**
   * Caminho do botão "Promover" de UM card (D300): resolve o worker da própria
   * linha e promove só ela, carimbando quem clicou.
   *
   * Existe para o controller não precisar saber que a promoção é indexada por
   * worker — e para a resolução do par (linha → worker) não ser reescrita na
   * camada de interface.
   *
   * @returns `null` quando a linha não existe ou já foi promovida (404 para quem
   *          chama); caso contrário o resultado da promoção, que ainda pode ser
   *          `promoted: 0` se uma das guardas recusar (worker deixou de ser
   *          elegível, vaga fechada, WJA já existente) — o motivo vem em `reasons`.
   */
  async executeForBlockedApplication(
    blockedApplicationId: string,
    actor?: ActorContext,
  ): Promise<PromoteBlockedApplicationsResult | null> {
    const { rows } = await this.pool.query<{ worker_id: string | null }>(
      `SELECT worker_id FROM worker_blocked_applications
       WHERE id = $1 AND promoted_at IS NULL`,
      [blockedApplicationId],
    );

    const workerId = rows[0]?.worker_id;
    if (!workerId) return null;

    return this.execute(workerId, { blockedApplicationId, actor });
  }

  /**
   * @param workerId worker cujas tentativas bloqueadas serão promovidas.
   * @param opts     ver `PromoteBlockedApplicationsOptions`. Vazio = comportamento
   *                 original (varredura do worker inteiro, ator do sistema), que é
   *                 o que o handler do evento continua chamando.
   */
  async execute(
    workerId: string,
    opts: PromoteBlockedApplicationsOptions = {},
  ): Promise<PromoteBlockedApplicationsResult> {
    const log = logger.child({ workerId, useCase: 'PromoteBlockedApplicationsUseCase' });
    const result: PromoteBlockedApplicationsResult = { promoted: 0, skipped: 0, reasons: {} };

    const bumpSkip = (reason: string, count = 1): void => {
      result.skipped += count;
      result.reasons[reason] = (result.reasons[reason] ?? 0) + count;
    };

    let rows: BlockedRow[];
    try {
      const { rows: fetched } = await this.pool.query<BlockedRow>(
        `SELECT id, job_posting_id, acquisition_channel
         FROM worker_blocked_applications
         WHERE worker_id = $1 AND promoted_at IS NULL
           AND ($2::uuid IS NULL OR id = $2::uuid)`,
        [workerId, opts.blockedApplicationId ?? null],
      );
      rows = fetched;
    } catch (err) {
      log.warn({
        msg: 'failed to list unpromoted blocked applications (non-fatal)',
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    if (rows.length === 0) return result;

    // Guarda (c): revalidada UMA vez para o worker (aplica-se a todas as linhas
    // do worker) — o evento pode chegar atrasado em relação ao estado atual.
    try {
      await assertWorkerCanApply(this.pool, workerId);
    } catch (err) {
      if (err instanceof WorkerNotEligibleError) {
        bumpSkip('worker_not_eligible', rows.length);
        log.info({ msg: 'worker not eligible for promotion (re-check)', reason: err.reason });
        return result;
      }
      throw err;
    }

    for (const row of rows) {
      try {
        // Guarda (a): vaga válida
        const { rows: jpRows } = await this.pool.query<JobPostingGuardRow>(
          `SELECT is_draft, status FROM job_postings
           WHERE id = $1 AND deleted_at IS NULL`,
          [row.job_posting_id],
        );
        const jp = jpRows[0];
        if (!jp || jp.is_draft || jp.status === 'CLOSED') {
          bumpSkip('vacancy_invalid');
          continue;
        }

        // Guarda (b): NOT EXISTS WJA para o par, em qualquer stage
        const { rows: wjaRows } = await this.pool.query(
          `SELECT 1 FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
          [workerId, row.job_posting_id],
        );
        if (wjaRows.length > 0) {
          bumpSkip('wja_already_exists');
          continue;
        }

        // A marcação de promovido entra na MESMA transação: se ela falhar, a
        // candidatura não fica criada sem o vínculo.
        //
        // O ator distingue os dois caminhos que chegam aqui: a varredura
        // automática (worker completou o cadastro — decisão de máquina) e o botão
        // "Promover" do card (decisão de uma pessoa do time, D300).
        await withActorContext(
          this.pool,
          async (client) => {
            const { wjaId } = await this.createWjaUseCase.execute(client, {
              workerId,
              jobPostingId: row.job_posting_id,
              acquisitionChannel: row.acquisition_channel ?? NEUTRAL_CHANNEL,
            });

            await client.query(
              `UPDATE worker_blocked_applications
               SET promoted_at = NOW(), promoted_wja_id = $2
               WHERE id = $1`,
              [row.id, wjaId],
            );
          },
          opts.actor ?? systemActor('promote-blocked'),
        );

        result.promoted += 1;
      } catch (err) {
        const pgErr = err as { code?: string };
        const reason = pgErr.code === '23505' ? 'unique_conflict' : 'error';
        bumpSkip(reason);
        log.warn({
          msg: 'failed to promote blocked application row (skipped, continuing)',
          blockedApplicationId: row.id,
          jobPostingId: row.job_posting_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info({
      msg: 'promotion sweep finished',
      promoted: result.promoted,
      skipped: result.skipped,
      reasons: result.reasons,
    });
    return result;
  }
}
