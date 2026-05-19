import { Pool } from 'pg';
import { PubSubClient } from '../PubSubClient';
import { MatchmakingService } from '../../../modules/matching/infrastructure/MatchmakingService';
import { TokenService } from '../../../modules/notification/infrastructure/TokenService';
import { logger, reportError, loggingAls } from '../../logging';

const TEMPLATE_SLUG = 'vacancy_invited_auto';
const IDEMPOTENCY_DAYS = 7;

interface VacancyCreatedPayload {
  jobPostingId?: string;
}

interface JobRow {
  case_number: number | null;
}

/**
 * Handler para o evento `vacancy.created`.
 *
 * Fluxo:
 *   1. Busca case_number da vaga
 *   2. Roda matchmaking (grava INVITED em worker_job_applications)
 *   3. Para cada candidato novo (alreadyApplied=false):
 *      a. Verifica idempotência (7 dias, status pending|sent)
 *      b. Gera token PII para worker_name via TokenService
 *      c. Insere em messaging_outbox
 *      d. Publica Pub/Sub para processamento imediato
 *
 * Idempotente: SELECT EXISTS com janela de 7 dias evita duplicação
 * em caso de retry do domain_event.
 *
 * Erro por candidato não bloqueia os demais — loop continua.
 */
export function createVacancyAutoInviteHandler(
  db: Pool,
  pubsub: PubSubClient,
): (payload: Record<string, unknown>) => Promise<void> {
  return async (payload: Record<string, unknown>): Promise<void> => {
    const { jobPostingId } = payload as VacancyCreatedPayload;
    if (!jobPostingId || typeof jobPostingId !== 'string') {
      throw new Error('Missing jobPostingId in vacancy.created payload');
    }

    const log = logger.child({ jobPostingId, handler: 'VacancyAutoInvite' });
    log.info('Starting auto-invite');

    // 1. Buscar case_number (não vem no MatchResult)
    const jobRes = await db.query<JobRow>(
      `SELECT case_number FROM job_postings WHERE id = $1 LIMIT 1`,
      [jobPostingId],
    );
    if (jobRes.rows.length === 0) {
      log.warn('Job posting not found, skipping');
      return;
    }
    const caseNumber = jobRes.rows[0].case_number ?? 0;

    // 2. Rodar matchmaking (já grava INVITED em worker_job_applications)
    const matchService = new MatchmakingService();
    const matchResult = await matchService.matchWorkersForJob(jobPostingId, {});

    // 3. Filtrar candidatos recém-convidados (alreadyApplied=false → inseridos agora)
    const newlyInvited = matchResult.candidates.filter(c => !c.alreadyApplied);
    log.info(
      { total: matchResult.candidates.length, newlyInvited: newlyInvited.length },
      'Match complete',
    );

    if (newlyInvited.length === 0) return;

    // 4. TokenService para PII (worker_name)
    const tokenService = new TokenService(db);

    let enqueued = 0;
    let skipped = 0;

    for (const candidate of newlyInvited) {
      try {
        // Idempotência: já enfileirado nos últimos 7 dias?
        const existsRes = await db.query<{ exists: boolean }>(
          `SELECT EXISTS(
            SELECT 1 FROM messaging_outbox
            WHERE worker_id = $1
              AND job_posting_id = $2
              AND template_slug = $3
              AND created_at > NOW() - INTERVAL '${IDEMPOTENCY_DAYS} days'
              AND status IN ('pending', 'sent')
          ) AS exists`,
          [candidate.workerId, jobPostingId, TEMPLATE_SLUG],
        );
        if (existsRes.rows[0]?.exists) {
          skipped++;
          continue;
        }

        // Token PII via TokenService (NÃO plaintext no JSONB)
        const workerNameToken = await tokenService.generate(candidate.workerId, 'worker_name');

        // patient_zone: vem do candidato (workZone); fallback para evitar template quebrado
        // Nota: zone_neighborhood está deprecated (migration 083) — pode ser NULL em vagas antigas.
        // Para vagas novas, workZone é preenchido pelo MatchmakingService via work_zone do worker.
        const patientZone = candidate.workZone ?? 'tu zona';

        const variables = {
          worker_name: workerNameToken,
          vacancy_case_number: String(caseNumber),
          distance_km: candidate.distanceKm !== null ? String(candidate.distanceKm) : '?',
          patient_zone: patientZone,
        };

        const traceId = loggingAls.getStore()?.traceId ?? null;

        const insertRes = await db.query<{ id: string }>(
          `INSERT INTO messaging_outbox
             (worker_id, job_posting_id, template_slug, variables, status, attempts, trace_id)
           VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, $5)
           RETURNING id`,
          [
            candidate.workerId,
            jobPostingId,
            TEMPLATE_SLUG,
            JSON.stringify(variables),
            traceId,
          ],
        );

        // Publicar Pub/Sub para processamento imediato (sweep 5 min é safety net)
        await pubsub.publish('outbox-enqueued', { outboxId: insertRes.rows[0].id });
        enqueued++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn({ workerId: candidate.workerId, error: error.message }, 'Failed to enqueue invite');
        reportError(error, {
          source: 'VacancyAutoInviteHandler:perCandidate',
          jobPostingId,
          workerId: candidate.workerId,
        });
        // Continua para próximo candidato
      }
    }

    log.info({ enqueued, skipped }, 'Auto-invite complete');
  };
}
