import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { preIniciadoWjaSql } from '../infrastructure/BlockedApplicationQueryRepository';

export interface CreateManualWjaWithEncuadreParams {
  workerId: string;
  jobPostingId: string;
  /** Canal de aquisição (facebook, instagram, etc.) ou null quando ausente/desconhecido. */
  acquisitionChannel: string | null;
  /** Nome decriptado do worker (para o campo de auditoria worker_raw_name do encuadre). */
  workerName?: string;
  /** Telefone do worker (para o campo de auditoria worker_raw_phone do encuadre). */
  workerPhone?: string;
}

export interface CreateManualWjaWithEncuadreResult {
  /** id do worker_job_applications criado/atualizado (null só se a query não retornar linha). */
  wjaId: string | null;
}

/**
 * CreateManualWjaWithEncuadreUseCase
 *
 * Extraído de WorkerApplicationsController.trackChannel (linhas 134-161 antes da
 * extração) — mesma lógica, zero mudança de comportamento para o caller original.
 *
 * Cria (ou atualiza first-touch-wins) um worker_job_applications com
 * source='manual', application_funnel_stage='INVITED' (uma linha pré-Iniciado do par vira
 * 'manual' e a mudança é gravada no histórico — D474/M6), e garante que existe um
 * encuadre correspondente (para o worker aparecer no Kanban INICIADO).
 *
 * Reusado por:
 *   - WorkerApplicationsController.trackChannel — worker clica em "postularse".
 *   - PromoteBlockedApplicationsUseCase — worker completa cadastro depois de ter
 *     sido bloqueado; promove a tentativa registrada em worker_blocked_applications.
 *
 * Aceita Pool ou PoolClient para permitir uso dentro de uma transação existente
 * (embora hoje nenhum caller passe PoolClient — mantido para flexibilidade futura).
 */
export class CreateManualWjaWithEncuadreUseCase {
  async execute(
    db: Pool | PoolClient,
    params: CreateManualWjaWithEncuadreParams,
  ): Promise<CreateManualWjaWithEncuadreResult> {
    const { workerId, jobPostingId, acquisitionChannel } = params;
    const workerName = params.workerName ?? '';
    const workerPhone = params.workerPhone ?? '';

    // Upsert WJA: source='manual', stage='INVITED' (pré-Talentum — migration 230).
    // ON CONFLICT: acquisition_channel só é preenchido se estiver NULL (first-touch wins) e
    // NUNCA se sobrescreve application_funnel_stage. A única mudança de `source` (M6, D474):
    // a linha PRÉ-INICIADO do par (convite/match do sistema, INVITED + source<>'manual') vira
    // 'manual' — o clique é a postulação. Qualquer outra etapa (PRE_SCREENING, SELECTED,
    // REJECTED...) não muda (M6a: sair de Rejeitados exige motivo, o clique não é motivo).
    // O CTE `prev` lê a linha ANTES do upsert (mesmo snapshot do comando), para saber se houve
    // promoção e qual era o source. (Sem FOR UPDATE: travar a linha que o `up` vai atualizar, no
    // mesmo comando, faz o lock pular a linha e `prev` volta vazio.)
    const wjaResult = await db.query(
      `WITH prev AS (
         SELECT id, source FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2 AND ${preIniciadoWjaSql('worker_job_applications')}
       ), up AS (
         INSERT INTO worker_job_applications
           (worker_id, job_posting_id, source, acquisition_channel, application_funnel_stage)
         VALUES ($1, $2, 'manual', $3, 'INVITED')
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           acquisition_channel = CASE
             WHEN worker_job_applications.acquisition_channel IS NULL THEN EXCLUDED.acquisition_channel
             ELSE worker_job_applications.acquisition_channel
           END,
           source = CASE
             WHEN ${preIniciadoWjaSql('worker_job_applications')} THEN 'manual'
             ELSE worker_job_applications.source
           END,
           updated_at = NOW()
         RETURNING id
       )
       SELECT up.id, prev.id IS NOT NULL AS promoted, prev.source AS previous_source
       FROM up LEFT JOIN prev ON prev.id = up.id`,
      [workerId, jobPostingId, acquisitionChannel],
    );

    const wjaRow = wjaResult.rows[0] as
      | { id: string; promoted: boolean; previous_source: string | null }
      | undefined;

    // Trilha da mudança de source (M6): mesmo formato do trigger fn_log_application_stage_change
    // (migration 169/478), com field_name='source'. `changed_by` vem do ator da transação
    // (withActorContext → app.current_uid): no clique é `worker_self:...`, o que também acende o
    // "levantou a mão" (self_applied_at). Sem migration: field_name/old_value são VARCHAR livres.
    if (wjaRow?.promoted) {
      await db.query(
        `INSERT INTO worker_job_application_stage_history
           (application_id, field_name, old_value, new_value, changed_by)
         VALUES ($1, 'source', $2, 'manual', current_setting('app.current_uid', true))`,
        [wjaRow.id, wjaRow.previous_source],
      );
    }

    // Ensure encuadre exists so the worker appears in the Kanban INICIADO column.
    // Only creates if no encuadre exists (preserves Talentum encuadres).
    const dedupHash = crypto.createHash('md5')
      .update(`social-link|${workerId}|${jobPostingId}`)
      .digest('hex');

    await db.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
       SELECT $1, $2, $4, $5, $6, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM encuadres e WHERE e.worker_id = $1 AND e.job_posting_id = $2
       )
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [workerId, jobPostingId, dedupHash, workerName, workerPhone, acquisitionChannel],
    );

    return { wjaId: wjaRow?.id ?? null };
  }
}
