import { Pool } from 'pg';
import { CloudTasksClient } from '../CloudTasksClient';
import { MatchmakingService } from '../../../modules/matching/infrastructure/MatchmakingService';
import { TokenService } from '../../../modules/notification/infrastructure/TokenService';
import { logger, reportError, loggingAls } from '../../logging';

const TEMPLATE_SLUG_COMPLETE   = 'ar_vacancy_match_complete';
const TEMPLATE_SLUG_INCOMPLETE = 'ar_vacancy_match_incomplete';
const IDEMPOTENCY_DAYS = 7;

// Queue dedicada com rate limit 0.5 msg/sec (config GCP) — paced pra
// evitar burst que Meta classificaria como spam. Veja:
// gcloud tasks queues describe whatsapp-paced --location=southamerica-east1
const WHATSAPP_PACED_QUEUE = process.env.WHATSAPP_PACED_QUEUE ?? 'whatsapp-paced';

interface VacancyCreatedPayload {
  jobPostingId?: string;
}

interface PatientZoneRow {
  patient_zone: string | null;
}

interface WorkerDocumentsRow {
  resume_cv_url:                string | null;
  identity_document_url:        string | null;
  criminal_record_url:          string | null;
  professional_registration_url: string | null;
  liability_insurance_url:       string | null;
}

/**
 * Handler para o evento `vacancy.created`.
 *
 * Fluxo:
 *   1. Busca zona do paciente via JOIN job_postings → patients
 *   2. Roda matchmaking (grava INVITED em worker_job_applications)
 *   3. Para cada candidato recém-convidado (alreadyApplied=false):
 *      a. Verifica idempotência (7 dias, qualquer template ar_vacancy_match_*)
 *      b. Decide template baseado em workerStatus:
 *           REGISTERED              → ar_vacancy_match_complete (3 vars)
 *           INCOMPLETE_REGISTER     → ar_vacancy_match_incomplete (4 vars)
 *           qualquer outro / null   → skip
 *      c. Gera token PII para worker_name via TokenService
 *      d. Para INCOMPLETE: monta lista de documentos pendentes
 *      e. Insere em messaging_outbox
 *      f. Publica Pub/Sub para processamento imediato
 *
 * Idempotente: SELECT EXISTS com janela de 7 dias evita duplicação
 * em caso de retry do domain_event.
 *
 * Erro por candidato não bloqueia os demais — loop continua.
 *
 * Fix TD-019: patient_zone agora vem do paciente via JOIN com patients,
 * não mais do workZone do AT.
 */
export function createVacancyAutoInviteHandler(
  db: Pool,
  cloudTasks: CloudTasksClient,
): (payload: Record<string, unknown>) => Promise<void> {
  return async (payload: Record<string, unknown>): Promise<void> => {
    const { jobPostingId } = payload as VacancyCreatedPayload;
    if (!jobPostingId || typeof jobPostingId !== 'string') {
      throw new Error('Missing jobPostingId in vacancy.created payload');
    }

    const log = logger.child({ jobPostingId, handler: 'VacancyAutoInvite' });
    log.info('Starting auto-invite');

    // 1. Buscar zona do paciente via JOIN (fix TD-019: não usa workZone do AT)
    const zoneRes = await db.query<PatientZoneRow>(
      `SELECT p.zone_neighborhood AS patient_zone
       FROM job_postings jp
       LEFT JOIN patients p ON p.id = jp.patient_id
       WHERE jp.id = $1
       LIMIT 1`,
      [jobPostingId],
    );
    if (zoneRes.rows.length === 0) {
      log.warn('Job posting not found, skipping');
      return;
    }
    const patientZone = zoneRes.rows[0].patient_zone ?? 'tu zona';

    // 2. Rodar matchmaking — includeIncompleteRegister=true: workers com cadastro
    //    pendente também recebem convite (template ar_vacancy_match_incomplete
    //    avisa que tem vaga + pede pra completar perfil pra postular).
    const matchService = new MatchmakingService();
    const matchResult = await matchService.matchWorkersForJob(jobPostingId, {
      includeIncompleteRegister: true,
    });

    // 3. Filtrar candidatos recém-convidados (alreadyApplied=false → inseridos agora)
    const newlyInvited = matchResult.candidates.filter(c => !c.alreadyApplied);
    log.info(
      { total: matchResult.candidates.length, newlyInvited: newlyInvited.length },
      'Match complete',
    );

    if (newlyInvited.length === 0) return;

    // 4. TokenService para PII (worker_name)
    const tokenService = new TokenService(db);

    const vacancyUrl = `https://app.enlite.health/vacancies/${jobPostingId}`;

    let enqueued = 0;
    let skipped = 0;

    for (const candidate of newlyInvited) {
      try {
        // Decide template baseado em workerStatus
        const workerStatus = candidate.workerStatus;
        if (workerStatus !== 'REGISTERED' && workerStatus !== 'INCOMPLETE_REGISTER') {
          // DISABLED ou status desconhecido — skip
          skipped++;
          continue;
        }

        const isComplete     = workerStatus === 'REGISTERED';
        const templateSlug   = isComplete ? TEMPLATE_SLUG_COMPLETE : TEMPLATE_SLUG_INCOMPLETE;

        // Opt-out: worker pediu pra não receber mensagens
        const optOutRes = await db.query<{ exists: boolean }>(
          `SELECT EXISTS(
            SELECT 1 FROM messaging_opt_out
            WHERE worker_id = $1 AND opted_in_at IS NULL
          ) AS exists`,
          [candidate.workerId],
        );
        if (optOutRes.rows[0]?.exists) {
          skipped++;
          continue;
        }

        // Cooldown global: não enviar se worker recebeu qualquer msg nos últimos 3 dias
        const cooldownRes = await db.query<{ exists: boolean }>(
          `SELECT EXISTS(
            SELECT 1 FROM whatsapp_bulk_dispatch_logs
            WHERE worker_id = $1
              AND status = 'sent'
              AND dispatched_at > NOW() - INTERVAL '3 days'
          ) AS exists`,
          [candidate.workerId],
        );
        if (cooldownRes.rows[0]?.exists) {
          skipped++;
          continue;
        }

        // Idempotência: já enfileirado nos últimos 7 dias para qualquer template ar_vacancy_match_*?
        const existsRes = await db.query<{ exists: boolean }>(
          `SELECT EXISTS(
            SELECT 1 FROM messaging_outbox
            WHERE worker_id = $1
              AND job_posting_id = $2
              AND template_slug IN ($3, $4)
              AND created_at > NOW() - INTERVAL '${IDEMPOTENCY_DAYS} days'
              AND status IN ('pending', 'sent')
          ) AS exists`,
          [candidate.workerId, jobPostingId, TEMPLATE_SLUG_COMPLETE, TEMPLATE_SLUG_INCOMPLETE],
        );
        if (existsRes.rows[0]?.exists) {
          skipped++;
          continue;
        }

        // Token PII via TokenService (NÃO plaintext no JSONB)
        const workerNameToken = await tokenService.generate(candidate.workerId, 'worker_name');

        const traceId = loggingAls.getStore()?.traceId ?? null;

        let variables: Record<string, string>;
        if (isComplete) {
          variables = {
            worker_name: workerNameToken,
            patient_zone: patientZone,
            vacancy_url:  vacancyUrl,
          };
        } else {
          const pendingDocs = await formatPendingDocuments(db, candidate.workerId);
          variables = {
            worker_name:       workerNameToken,
            patient_zone:      patientZone,
            pending_documents: pendingDocs,
            vacancy_url:       vacancyUrl,
          };
        }

        const insertRes = await db.query<{ id: string }>(
          `INSERT INTO messaging_outbox
             (worker_id, job_posting_id, template_slug, variables, status, attempts, trace_id)
           VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, $5)
           RETURNING id`,
          [
            candidate.workerId,
            jobPostingId,
            templateSlug,
            JSON.stringify(variables),
            traceId,
          ],
        );

        // Agendar Cloud Task na queue whatsapp-paced — rate limit 0.5/s
        // configurado no GCP previne burst que Meta classificaria como spam.
        // Queue gerencia retry (max 3, backoff exponencial). Sweep 5min é
        // safety net pra casos extremos onde a task falhou todas as tentativas.
        await cloudTasks.schedule({
          queue: WHATSAPP_PACED_QUEUE,
          url: '/api/internal/outbox/process-paced',
          body: { outboxId: insertRes.rows[0].id },
        });
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

/**
 * Monta a string de documentos pendentes para o template ar_vacancy_match_incomplete.
 *
 * Consulta worker_documents e lista campos NULL como itens separados por " y ".
 * Se TUDO está preenchido (caso raro com status='INCOMPLETE_REGISTER'), retorna
 * o fallback "completar tu perfil".
 */
export async function formatPendingDocuments(db: Pool, workerId: string): Promise<string> {
  const res = await db.query<WorkerDocumentsRow>(
    `SELECT resume_cv_url,
            identity_document_url,
            criminal_record_url,
            professional_registration_url,
            liability_insurance_url
     FROM worker_documents
     WHERE worker_id = $1
     LIMIT 1`,
    [workerId],
  );

  const pending: string[] = [];

  if (res.rows.length === 0) {
    // Sem linha em worker_documents — todos os documentos estão faltando
    return 'tu CV, tu DNI, tus antecedentes penales, tu matrícula profesional y tu seguro de responsabilidad civil';
  }

  const row = res.rows[0];
  if (!row.resume_cv_url)                pending.push('tu CV');
  if (!row.identity_document_url)        pending.push('tu DNI');
  if (!row.criminal_record_url)          pending.push('tus antecedentes penales');
  if (!row.professional_registration_url) pending.push('tu matrícula profesional');
  if (!row.liability_insurance_url)      pending.push('tu seguro de responsabilidad civil');

  if (pending.length === 0) {
    // Caso raro: status=INCOMPLETE_REGISTER mas todos os docs preenchidos
    return 'completar tu perfil';
  }

  // Concatena com " y " entre os últimos dois e ", " entre os demais
  if (pending.length === 1) return pending[0];
  const last = pending.pop()!;
  return `${pending.join(', ')} y ${last}`;
}
