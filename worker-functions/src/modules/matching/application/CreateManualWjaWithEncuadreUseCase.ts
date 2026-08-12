import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';

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
 * source='manual', application_funnel_stage='INVITED', e garante que existe um
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
    // ON CONFLICT: só atualiza acquisition_channel se estiver NULL (first-touch wins).
    // Nunca sobrescreve application_funnel_stage/source de uma linha existente —
    // se o par já tem WJA (qualquer stage), essa query só toca acquisition_channel.
    const wjaResult = await db.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, source, acquisition_channel, application_funnel_stage)
       VALUES ($1, $2, 'manual', $3, 'INVITED')
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         acquisition_channel = CASE
           WHEN worker_job_applications.acquisition_channel IS NULL THEN EXCLUDED.acquisition_channel
           ELSE worker_job_applications.acquisition_channel
         END,
         updated_at = NOW()
       RETURNING id`,
      [workerId, jobPostingId, acquisitionChannel],
    );

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

    return { wjaId: (wjaResult.rows[0]?.id as string | undefined) ?? null };
  }
}
