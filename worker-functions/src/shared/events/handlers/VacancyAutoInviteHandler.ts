import { Pool } from 'pg';
import { CloudTasksClient } from '../CloudTasksClient';
import { MatchmakingService } from '../../../modules/matching/infrastructure/MatchmakingService';
import { TokenService } from '../../../modules/notification/infrastructure/TokenService';
import { logger, reportError, loggingAls } from '../../logging';
import { getRequiredColumns } from '../../../modules/worker/application/workerDocumentPolicy';
import { assertVacancyInviteAllowed } from '../../../modules/notification/application/VacancyInviteGuard';

const TEMPLATE_SLUG_COMPLETE   = 'ar_vacancy_match_complete';
const TEMPLATE_SLUG_INCOMPLETE = 'ar_vacancy_match_incomplete';

// Queue dedicada com rate limit 0.5 msg/sec (config GCP) — paced pra
// evitar burst que Meta classificaria como spam. Veja:
// gcloud tasks queues describe whatsapp-paced --location=southamerica-east1
const WHATSAPP_PACED_QUEUE = process.env.WHATSAPP_PACED_QUEUE ?? 'whatsapp-paced';

interface VacancyCreatedPayload {
  jobPostingId?: string;
}

interface PatientZoneRow {
  patient_zone: string | null;
  is_test: boolean;
}

interface WorkerDocumentsRow {
  profession:                    string | null;
  has_documents:                 boolean;
  identity_document_url:         string | null;
  identity_document_back_url:    string | null;
  criminal_record_url:           string | null;
  resume_cv_url:                 string | null;
  at_certificate_url:            string | null;
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
      `SELECT p.zone_neighborhood AS patient_zone, jp.is_test
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

    const row = zoneRes.rows[0];

    // Guarda de vaga de teste/QA (migration 248, vacancyCrudHelpers.ts is_test):
    // early-return ANTES de rodar matchmaking. Cobre matchmaking + WJA + outbox +
    // WhatsApp de uma vez só, por ser o único ponto de entrada do handler.
    //
    // IMPLICAÇÃO (PR #128): o futuro teste do funil WhatsApp (tier-3) NÃO poderá
    // usar o auto-invite pra disparar WhatsApp de vaga is_test — vai precisar
    // disparar explicitamente via endpoint dedicado ou fluxo manual. Isso é
    // diferente do isolamento de realm em SameRealmSpecification (que só filtra
    // worker↔vaga por DataRealm dentro do matchmaking): aqui é bloqueio total,
    // mesmo que exista worker is_test elegível na mesma zona.
    if (row.is_test === true) {
      log.info('is_test vacancy — skipping auto-invite');
      return;
    }

    const patientZone = row.patient_zone ?? 'tu zona';

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

    const vacancyUrl = `https://app.enlite.health/vacantes/${jobPostingId}`;

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

        // Guard compartilhado (mesmas travas do disparo manual): opt-out,
        // cooldown 3d, idempotência 7d (outbox + bulk logs) e throttle de
        // não-resposta. Fonte única de verdade — auto e manual não divergem.
        const guard = await assertVacancyInviteAllowed(db, candidate.workerId, jobPostingId);
        if (!guard.allowed) {
          skipped++;
          log.info({ workerId: candidate.workerId, code: guard.code }, 'Convite bloqueado pelo guard');
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

/** Maps required SQL column names to their Spanish labels used in WhatsApp messages. */
const COLUMN_TO_LABEL: Record<string, string> = {
  identity_document_url:      'tu DNI',
  identity_document_back_url: 'el dorso de tu DNI',
  criminal_record_url:        'tus antecedentes penales',
  resume_cv_url:              'tu CV',
  at_certificate_url:         'tu certificado de AT',
};

/**
 * Monta a string de documentos pendentes para o template ar_vacancy_match_incomplete.
 *
 * Faz JOIN com workers para obter a profissão do worker e determina quais colunas
 * são obrigatórias conforme workerDocumentPolicy.getRequiredColumns(profession).
 * Lista apenas as obrigatórias que estiverem NULL.
 *
 * Se TUDO está preenchido (caso raro com status='INCOMPLETE_REGISTER'), retorna
 * o fallback "completar tu perfil".
 */
export async function formatPendingDocuments(db: Pool, workerId: string): Promise<string> {
  const res = await db.query<WorkerDocumentsRow>(
    `SELECT w.profession,
            (wd.worker_id IS NOT NULL) AS has_documents,
            wd.identity_document_url,
            wd.identity_document_back_url,
            wd.criminal_record_url,
            wd.resume_cv_url,
            wd.at_certificate_url
     FROM workers w
     LEFT JOIN worker_documents wd ON wd.worker_id = w.id
     WHERE w.id = $1
     LIMIT 1`,
    [workerId],
  );

  const requiredColumns = getRequiredColumns(res.rows[0]?.profession ?? null);

  if (res.rows.length === 0 || !res.rows[0].has_documents) {
    // Worker não encontrado ou sem linha em worker_documents — todos obrigatórios faltando
    const allLabels = requiredColumns.map(col => COLUMN_TO_LABEL[col]).filter(Boolean);
    return joinWithY(allLabels) || 'completar tu perfil';
  }

  const row = res.rows[0];
  const pending: string[] = [];

  for (const col of requiredColumns) {
    const value = row[col as keyof WorkerDocumentsRow];
    if (!value) {
      const label = COLUMN_TO_LABEL[col];
      if (label) pending.push(label);
    }
  }

  if (pending.length === 0) {
    // Caso raro: status=INCOMPLETE_REGISTER mas todos os docs obrigatórios preenchidos
    return 'completar tu perfil';
  }

  return joinWithY(pending);
}

/**
 * Concatena itens com ", " entre os primeiros e " y " antes do último.
 * Ex: ['a', 'b', 'c'] → 'a, b y c'
 *     ['a']           → 'a'
 */
function joinWithY(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  const rest = items.slice(0, -1);
  return `${rest.join(', ')} y ${last}`;
}
