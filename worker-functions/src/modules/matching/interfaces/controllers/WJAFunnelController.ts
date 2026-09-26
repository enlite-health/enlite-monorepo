import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { reportError } from '@shared/logging';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../../domain/WorkerApplicationEligibility';
import { BlockedApplicationQueryRepository } from '../../infrastructure/BlockedApplicationQueryRepository';
import { BlockedApplicationRepository } from '../../infrastructure/BlockedApplicationRepository';
import { deriveKanbanColumn, isMatchedNotInvited, KANBAN_COLUMN_BLOCKED } from '../../domain/kanbanColumn';
import {
  interviewScheduleSchema,
  interviewDatetimeSql,
  INTERVIEW_DATE_RESOLVED_SQL,
  INTERVIEW_TIME_RESOLVED_SQL,
} from '../../domain/interviewSchedule';
import { REJECTION_REASON_CATEGORIES } from '../../domain/Encuadre';
import { cellsOfRequest, projectWorkerFields, NOME_REDIGIDO } from '@modules/identity/permissions';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { RESEND_COOLDOWN_HOURS, resendCooldownUntilSql } from '../../../notification/application/VacancyInviteGuard';
import { PubSubClient } from '@shared/events/PubSubClient';
import { emitFunnelStageEvent, FUNNEL_STAGES, isFunnelStage } from '../../application/FunnelStageEventEmitter';

/**
 * Papel opcional ao mover para SELECTED (feature "Equipe Armada").
 * TITULAR=titular, RAPID_RESPONSE=substituto. Ausente = fica pendente de
 * classificação (bucket PENDENTE_CLASSIFICACAO no dashboard de gestão).
 */
const encuadreRoleSchema = z.enum(['TITULAR', 'RAPID_RESPONSE']);


/**
 * WJAFunnelController
 *
 * Kanban funnel endpoints for vacancy WJA management.
 * Dashboard endpoints (coordinator-capacity, alerts, conversion-by-channel)
 * live in EncuadreDashboardController.
 *
 * - GET  /api/admin/vacancies/:id/funnel  — WJAs grouped by stage
 * - PUT  /api/admin/encuadres/:id/move    — move WJA in kanban
 *
 * Renamed from EncuadreFunnelController in F7.a (migration 194).
 * WJA is the canonical entity; encuadre is enrichment data only.
 *
 * Migration 230 (2026-06-26): Kanban redesign
 *   - INITIATED column removed (stage renamed to PRE_SCREENING in DB)
 *   - PRE_SCREENING column added (Talentum entry point)
 *   - INICIADO column added: INVITED+source='manual' WJAs
 *
 * Feature BLOQUEADO (2026-07-03): tentativas negadas (dispensadas ou não) →
 * Rejeitados, D433 (worker_blocked_applications cards não promovidas caem em
 * KANBAN_COLUMN_BLOCKED = REJECTED). Promoted (worker completed registration)
 * blocked attempts stop appearing here and become real WJA cards in INICIADO
 * (see PromoteBlockedApplicationsUseCase).
 */
export class WJAFunnelController {
  private db: Pool;
  private pubsub: PubSubClient;
  private blockedRepo: BlockedApplicationQueryRepository;
  private blockedWriteRepo: BlockedApplicationRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.pubsub = new PubSubClient();
    this.blockedRepo = new BlockedApplicationQueryRepository();
    this.blockedWriteRepo = new BlockedApplicationRepository();
  }

  /**
   * GET /api/admin/vacancies/:id/funnel
   *
   * Returns all worker_job_applications for a vacancy grouped by funnel stage.
   * WJA is the primary source; encuadre is joined LATERAL (optional) to enrich
   * cards that already have one. Orphan WJAs (no encuadre) are now visible.
   *
   * Card identifier: wja.id (always present). encuadreId: e.id (null for orphans).
   *
   * Columns (Migration 230 + feature BLOQUEADO):
   *   INVITED    — WJA stage=INVITED, source != 'manual' (auto-invite system)
   *   REJECTED   — inclui tentativas negadas (dispensadas ou não) não promovidas, D433
   *   INICIADO   — WJA stage=INVITED + source='manual' (postulação real, não-bloqueada)
   *   PRE_SCREENING — WJA stage=PRE_SCREENING (antigo INITIATED)
   *   IN_PROGRESS, COMPLETED, CONFIRMED, SELECTED, REJECTED — inalterados
   */
  async getEncuadreFunnel(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const [result, blockedAttempts] = await Promise.all([
        this.db.query(
          `SELECT
             wja.id,
             wja.worker_id,
             w.first_name_encrypted,
             w.last_name_encrypted,
             COALESCE(w.phone, e.worker_raw_phone) AS worker_phone,
             e.occupation_raw,
             -- Resolução das duas fontes num helper único (domain/interviewSchedule), agora no
             -- fuso da OPERAÇÃO e não em UTC: entrevista às 21h em Buenos Aires é meia-noite
             -- UTC e aparecia no dia seguinte. Sem impacto retroativo: interview_datetime
             -- está em 0 de 13.046 linhas hoje; só o legado (date puro) alimenta a tela.
             ${INTERVIEW_DATE_RESOLVED_SQL} AS interview_date,
             ${INTERVIEW_TIME_RESOLVED_SQL} AS interview_time,
             COALESCE(wja.interview_meet_link, e.meet_link) AS meet_link,
             e.resultado,
             e.attended,
             e.rejection_reason_category,
             e.rejection_reason,
             e.redireccionamiento,
             e.id AS encuadre_id,
             wja.match_score,
             wja.interview_response,
             wja.acquisition_channel,
             wja.application_funnel_stage AS funnel_stage,
             wja.source,
             wja.messaged_at,
             -- D200.1: quando a janela de reenvio (MANUAL_RESEND_COOLDOWN_HOURS) abre de novo
             -- para este worker×vaga, ou NULL se o "Reenviar" está livre. MESMA expressão que
             -- o guard usa para o 422 — o card desabilita o botão antes do clique.
             ${resendCooldownUntilSql('wja.worker_id', 'wja.job_posting_id', '$2')} AS resend_blocked_until,
             CASE WHEN wja.source != 'talentum' OR wja.source IS NULL THEN NULL
               WHEN (SELECT tp.status FROM talentum_prescreenings tp WHERE tp.worker_id = wja.worker_id AND tp.job_posting_id = wja.job_posting_id ORDER BY tp.updated_at DESC LIMIT 1) = 'PENDING' THEN 'PENDING'
               ELSE wja.application_funnel_stage END AS talentum_status,
             (SELECT COUNT(*)::int FROM wja_contact_notes cn
              WHERE cn.worker_id = wja.worker_id AND cn.job_posting_id = wja.job_posting_id) AS contact_notes_count,
             -- "Levantou a mão": o PRÓPRIO prestador entrou nesta vaga pelo link
             -- público (track-channel → ator worker_self: no trigger, D95). Sem
             -- este sinal o card fica idêntico a um convite frio e a pessoa espera
             -- em silêncio (caso Carina: 14 vagas em 3 semanas, ninguém falou com ela).
             -- NULL = não sabemos: a autoria só é gravada desde 06/08.
             (SELECT h.created_at::text FROM worker_job_application_stage_history h
              WHERE h.application_id = wja.id AND h.changed_by LIKE 'worker_self:%'
              ORDER BY h.created_at ASC LIMIT 1) AS self_applied_at,
             -- PEND-14/DEC-12: último template enfileirado POR ETAPA para esta candidatura
             -- (o card mostra "Último mensaje: <template> · <data>", trilha de medição Luz × humano).
             (SELECT json_build_object('stage', l.stage, 'templateSlug', l.template_slug, 'at', l.created_at)
              FROM funnel_stage_message_log l
              WHERE l.worker_id = wja.worker_id AND l.job_posting_id = wja.job_posting_id AND l.status = 'queued'
              ORDER BY l.created_at DESC LIMIT 1) AS last_stage_message,
             wsa.work_zone
           FROM worker_job_applications wja
           LEFT JOIN workers w ON w.id = wja.worker_id
           LEFT JOIN LATERAL (
             SELECT id, worker_raw_name, worker_raw_phone, occupation_raw,
                    interview_date, interview_time, meet_link, resultado, attended,
                    rejection_reason_category, rejection_reason, redireccionamiento
             FROM encuadres
             WHERE worker_id = wja.worker_id AND job_posting_id = wja.job_posting_id
             ORDER BY created_at DESC
             LIMIT 1
           ) e ON true
           LEFT JOIN worker_service_areas wsa ON wsa.worker_id = wja.worker_id AND wsa.deleted_at IS NULL
           WHERE wja.job_posting_id = $1
             -- worker que deu baixa na conta não pode aparecer no kanban da vaga
             -- (mesmo recorte de FunnelTableRepository/VacancyMatchController)
             AND ${excludeDisabledWorkersSql('w')}
           ORDER BY wja.updated_at DESC NULLS LAST, wja.created_at DESC`,
          [id, RESEND_COOLDOWN_HOURS],
        ),
        this.blockedRepo.listByVacancy(id),
      ]);

      // Colunas do Kanban — classificação 100% baseada em application_funnel_stage
      // Migration 230: INITIATED removido → PRE_SCREENING + INICIADO adicionados
      // Feature BLOQUEADO: tentativas negadas (dispensadas ou não) → Rejeitados, D433
      const stages: Record<string, unknown[]> = {
        INVITED: [],
        INICIADO: [],       // INVITED+source='manual' — postulação real, não-bloqueada
        PRE_SCREENING: [],  // Antigo INITIATED — entrou no formulário Talentum
        IN_PROGRESS: [],
        COMPLETED: [],      // agrupa COMPLETED + QUALIFIED + IN_DOUBT (tag diferencia)
        CONFIRMED: [],
        SELECTED: [],
        REJECTED: [],
      };

      const kms = new KMSEncryptionService();
      // F2/C3: a célula decide ANTES do KMS, nos DOIS sítios desta rota (cards
      // de WJA e cards de tentativa bloqueada). `cells === null` = o engine não
      // decidiu nesta request → a projeção devolve o que a rota já devolvia
      // (D113). NUNCA `?? []` aqui: `[]` redigiria o Kanban inteiro.
      const cells = cellsOfRequest(req);

      // Decrypt WJA names + blocked worker names em paralelo no controller (não no repo)
      const [visiveisWja, decryptedBlockedNames] = await Promise.all([
        Promise.all(result.rows.map(async (row): Promise<{ name: string; phone: string | null }> => {
          // O TELEFONE entra aqui junto do nome. Ele já vem em texto claro do
          // SQL (COALESCE(w.phone, e.worker_raw_phone)) e por isso não custa
          // KMS nenhum — se ficasse fora da projeção, sairia redigindo o nome e
          // entregando o telefone, que é o mesmo dado de contato.
          const visivel = await projectWorkerFields(cells, {
            firstNameEncrypted: row.first_name_encrypted,
            lastNameEncrypted: row.last_name_encrypted,
            phone: (row.worker_phone as string | null) ?? null,
          }, kms);
          // O pseudônimo é para "autorizado e sem nome"; a redação já tem texto
          // próprio e não pode ser sobrescrita por ele.
          const wid = row.worker_id as string | null;
          const name = visivel.name
            ?? (wid ? `Worker #${wid.slice(-8)}` : 'Worker sem identificação');
          return { name, phone: visivel.phone ?? null };
        })),
        Promise.all(blockedAttempts.map(async (ba): Promise<{ name: string | null; phone: string | null }> => {
          if (!ba.workerId) return { name: null, phone: null };
          // Fetch worker name (encrypted) + phone (plaintext — usado para dedup,
          // ver migrations/023_encrypt_all_pii.sql) para os cards bloqueados
          const workerRow = await this.db.query(
            `SELECT first_name_encrypted, last_name_encrypted, phone FROM workers WHERE id = $1`,
            [ba.workerId],
          );
          if (workerRow.rows.length === 0) return { name: null, phone: null };
          const wr = workerRow.rows[0];
          const visivel = await projectWorkerFields(cells, {
            firstNameEncrypted: wr.first_name_encrypted as string | null,
            lastNameEncrypted: wr.last_name_encrypted as string | null,
            phone: (wr.phone as string | null) ?? null,
          }, kms);
          return { name: visivel.name ?? null, phone: visivel.phone ?? null };
        })),
      ]);

      // C6: a trilha sai com quem teve o contato REVELADO, não com quem a página
      // trouxe. Ator redigido não gera linha — nada foi revelado.
      emitirTrilhaDeContato(
        req,
        result.rows.map((row, i) =>
          visiveisWja[i].name === NOME_REDIGIDO ? null : (row.worker_id as string | null)),
      );

      // Classify WJA rows into kanban columns
      let classifiedCount = 0;
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        const stage = row.funnel_stage as string | null;
        const source = row.source as string | null;

        // AC2 (86ajb48v1): a system match that was never messaged is a match
        // candidate, not an invitation — running a match writes ALL top-N as
        // INVITED/system, so keeping them here inflates "Invitados". They live
        // only in the match modal until a real send sets messaged_at.
        if (isMatchedNotInvited(stage, source, row.messaged_at as string | Date | null)) {
          continue;
        }
        classifiedCount++;

        const item = {
          id: row.id,
          encuadreId: row.encuadre_id ?? null,
          workerId: row.worker_id ?? null,
          workerName: visiveisWja[i].name,
          workerPhone: visiveisWja[i].phone,
          occupation: row.occupation_raw,
          interviewDate: row.interview_date,
          interviewTime: row.interview_time,
          meetLink: row.meet_link,
          resultado: row.resultado,
          attended: row.attended,
          rejectionReasonCategory: row.rejection_reason_category,
          rejectionReason: row.rejection_reason,
          matchScore: row.match_score,
          interviewResponse: row.interview_response ?? null,
          acquisitionChannel: row.acquisition_channel ?? null,
          talentumStatus: row.talentum_status ?? null,
          workZone: row.work_zone,
          redireccionamiento: row.redireccionamiento,
          internalStage: stage ?? null,
          contactNotesCount: Number(row.contact_notes_count ?? 0),
          selfAppliedAt: row.self_applied_at ?? null,
          // Último envio de WhatsApp a esta candidatura (manual ou em lote) —
          // o card mostra a data/hora ao lado do botão "Reenviar" (REQ-08).
          lastMessagedAt: row.messaged_at ? new Date(row.messaged_at as string | Date).toISOString() : null,
          // D200.1: motivo pelo qual o "Reenviar" está desabilitado AGORA (null = livre).
          // Só a janela de reenvio é calculada aqui; opt-out/throttle continuam no 422.
          lastStageMessage: (row.last_stage_message as { stage: string; templateSlug: string | null; at: string } | null) ?? null,
          resendBlockedReason: row.resend_blocked_until
            ? { code: 'RESEND_COOLDOWN', until: new Date(row.resend_blocked_until as string | Date).toISOString() }
            : null,
        };

        // Classificação 100% baseada em (stage, source) — SSOT em deriveKanbanColumn
        // (domain/kanbanColumn.ts), compartilhado com a aba de encuadre do worker-detail.
        stages[deriveKanbanColumn(stage, source)].push(item);
      }

      // Merge blocked attempt cards. Tentativas negadas (dispensadas ou não) →
      // Rejeitados, D433 (KANBAN_COLUMN_BLOCKED = REJECTED), como card de bloqueado
      // (não-arrastável, encuadreId null — coerente: um incompleto não pode ter WJA
      // nem andar no funil). listByVacancy já faz NOT EXISTS contra
      // worker_job_applications, então um bloqueado promovido vira WJA real e some
      // daqui automaticamente.
      for (let i = 0; i < blockedAttempts.length; i++) {
        const ba = blockedAttempts[i];
        const blockedWorker = decryptedBlockedNames[i];
        const isDismissed = ba.dismissedAt != null;
        stages[KANBAN_COLUMN_BLOCKED].push({
          id: ba.id,
          encuadreId: null,
          workerId: ba.workerId ?? null,
          workerName: blockedWorker?.name ?? null,
          workerPhone: blockedWorker?.phone ?? null,
          occupation: null,
          interviewDate: null,
          interviewTime: null,
          meetLink: null,
          resultado: null,
          attended: null,
          // Card rechazado mostra o badge de motivo (mesmo enum do rejeitado normal).
          rejectionReasonCategory: isDismissed ? ba.dismissedReason : null,
          rejectionReason: null,
          matchScore: null,
          interviewResponse: null,
          acquisitionChannel: ba.acquisitionChannel,
          talentumStatus: null,
          workZone: null,
          redireccionamiento: null,
          internalStage: null,
          // Notas de contato escritas enquanto o card estava bloqueado
          // (migration 235 — chave estável worker_id+job_posting_id).
          contactNotesCount: ba.contactNotesCount,
          // Blocked-specific fields
          isBlocked: true,
          blockedReason: ba.blockedReason,
          missingFields: ba.missingFields,
          attemptCount: ba.attemptCount,
          // Rechazado (soft-dismiss): habilita "voltar a bloqueados" no card em RECHAZADOS.
          isDismissed,
        });
      }

      res.json({
        success: true,
        data: {
          stages,
          totalEncuadres: classifiedCount, // WJAs shown on the board (excludes matched-not-invited system rows)
        },
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAFunnelController:getEncuadreFunnel' });
      res.status(500).json({ success: false, error: e.message });
    }
  }

  /**
   * PUT /api/admin/encuadres/:id/move
   *
   * Moves encuadre to a new Kanban column by updating application_funnel_stage.
   * Also syncs encuadre.resultado for terminal states (SELECTED/REJECTED).
   *
   * Body: { targetStage, rejectionReasonCategory?, rejectionReason?, role?,
   *         interviewDate?, interviewTime?, interviewMeetLink? }
   *
   * Migration 230: INITIATED replaced by PRE_SCREENING in validStages.
   * INVITED added to validStages — "Invitados" is a droppable column in the kanban
   * (KanbanBoard DROPPABLE_STAGES); its omission here 400'd every drop into it.
   *
   * interviewDate/Time (2026-07-30): mover para CONFIRMED registra QUANDO a entrevista é.
   * Até aqui o sistema gravava só que ela foi agendada — por isso lembrete de véspera,
   * lembrete de 5min e marcação de falta nunca dispararam (0 execuções cada). Ambas são
   * OPCIONAIS: "ainda não sei" é caminho válido (design D4), porque bloquear o movimento
   * faria a recrutadora inventar horário para destravar o card.
   */
  async moveEncuadre(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { targetStage, rejectionReasonCategory, rejectionReason, role } = req.body;

      const schedule = interviewScheduleSchema.safeParse({
        interviewDate: req.body?.interviewDate ?? undefined,
        interviewTime: req.body?.interviewTime ?? undefined,
        interviewMeetLink: req.body?.interviewMeetLink ?? undefined,
      });
      if (!schedule.success) {
        res.status(400).json({
          success: false,
          error: schedule.error.errors[0]?.message ?? 'Dados de agendamento inválidos',
        });
        return;
      }

      if (!isFunnelStage(targetStage)) {
        res.status(400).json({ success: false, error: `targetStage must be one of: ${FUNNEL_STAGES.join(', ')}` });
        return;
      }

      // Papel só é aceito ao selecionar; quando presente deve ser válido.
      let selectedRole: 'TITULAR' | 'RAPID_RESPONSE' | null = null;
      if (role !== undefined && role !== null) {
        const parsed = encuadreRoleSchema.safeParse(role);
        if (!parsed.success) {
          res.status(400).json({ success: false, error: "role must be one of: TITULAR, RAPID_RESPONSE" });
          return;
        }
        selectedRole = parsed.data;
      }

      // 1. Busca encuadre para obter worker_id + job_posting_id
      const encuadre = await this.db.query(
        `SELECT worker_id, job_posting_id FROM encuadres WHERE id = $1`,
        [id],
      );
      if (encuadre.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Encuadre not found' });
        return;
      }

      const { worker_id: workerId, job_posting_id: jobPostingId } = encuadre.rows[0];
      if (!workerId || !jobPostingId) {
        res.status(400).json({ success: false, error: 'Encuadre has no linked worker or job posting' });
        return;
      }

      try {
        await assertWorkerCanApply(this.db, workerId);
      } catch (err) {
        if (err instanceof WorkerNotEligibleError) {
          res.status(err.status).json({
            success: false,
            error: 'registration_incomplete',
            code: err.code,
            reason: err.reason,
            workerStatus: err.workerStatus,
          });
          return;
        }
        throw err;
      }

      // 2. Atualizar application_funnel_stage (fonte de verdade) + agendamento quando informado.
      // A conversão para timestamptz é feita pelo Postgres a partir do fuso da OPERAÇÃO
      // (interviewDatetimeSql) — nunca do fuso do navegador de quem arrastou o card.
      //
      // SQL ESTÁTICO de propósito: os placeholders $4/$5 são SEMPRE referenciados, com
      // CASE null-safe. A versão anterior interpolava 'NULL' quando não havia agendamento
      // e mantinha 6 valores no array → Postgres: "could not determine data type of
      // parameter $4" → 500 em TODO movimento sem data (pego pelo e2e de banco real;
      // mocks de db.query não veem isso).
      const { interviewDate, interviewTime, interviewMeetLink } = schedule.data;
      const datetimeInsertSql = `CASE WHEN $4::date IS NULL THEN NULL ELSE ${interviewDatetimeSql('$4', '$5')} END`;
      // No conflito, mover sem data NÃO apaga um agendamento já gravado.
      const datetimeUpdateSql = `CASE WHEN $4::date IS NULL THEN worker_job_applications.interview_datetime ELSE ${interviewDatetimeSql('$4', '$5')} END`;

      // As duas escritas rodam numa transação ÚNICA que carimba quem moveu o
      // card (o trigger de histórico lê `app.current_uid` — ver actorContext).
      // Efeito colateral desejado: a candidatura e o encuadre passam a mudar
      // juntos; antes, falha na 2ª query deixava a etapa já alterada.
      // PEND-14/DEC-12: o movimento vira EVENTO quando a etapa muda. A etapa
      // anterior é lida na mesma transação; o INSERT em domain_events roda no
      // mesmo client (etapa e evento nascem — ou não — juntos).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actorUid = ((req as any).user as { uid?: string } | undefined)?.uid ?? null;
      let stageEventId: string | null = null;
      await withActorContext(this.db, async (client) => {
        const prev = await client.query<{ application_funnel_stage: string | null }>(
          `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
          [workerId, jobPostingId],
        );
        const previousStage = prev.rows[0]?.application_funnel_stage ?? null;
        await client.query(
          `INSERT INTO worker_job_applications (
             worker_id, job_posting_id, application_funnel_stage, source,
             interview_datetime, interview_meet_link)
           VALUES (
             $1, $2, $3, 'manual',
             ${datetimeInsertSql},
             $6)
           ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
             application_funnel_stage = $3,
             interview_datetime = ${datetimeUpdateSql},
             interview_meet_link = COALESCE($6, worker_job_applications.interview_meet_link),
             updated_at = NOW()`,
          [
            workerId,
            jobPostingId,
            targetStage,
            interviewDate ?? null,
            interviewTime ?? null,
            interviewMeetLink ?? null,
          ],
        );

        // 3. Sincronizar encuadre.resultado para estados terminais
        if (targetStage === 'SELECTED') {
          // Grava o papel quando informado; sem papel o COALESCE preserva o
          // existente (re-mover não apaga a classificação anterior). Encuadre
          // selecionado sem papel = PENDENTE_CLASSIFICACAO no dashboard.
          await client.query(
            `UPDATE encuadres SET resultado = 'SELECCIONADO', role = COALESCE($2, role), updated_at = NOW() WHERE id = $1`,
            [id, selectedRole],
          );
        } else if (targetStage === 'REJECTED') {
          await client.query(
            `UPDATE encuadres SET resultado = 'RECHAZADO',
               rejection_reason_category = COALESCE($2, rejection_reason_category),
               rejection_reason = COALESCE($3, rejection_reason),
               updated_at = NOW()
             WHERE id = $1`,
            [id, rejectionReasonCategory ?? null, rejectionReason ?? null],
          );
        }

        stageEventId = await emitFunnelStageEvent(client, {
          workerId, jobPostingId, previousStage, targetStage, actorUid, source: 'kanban',
        });
      });

      // Depois do COMMIT: o evento já está gravado (pending); a publicação só
      // acelera o processamento — se falhar, a varredura de segurança reprocessa.
      if (stageEventId) {
        try {
          await this.pubsub.publish('talentum-prescreening-qualified', { eventId: stageEventId });
        } catch (err) {
          reportError(err instanceof Error ? err : new Error(String(err)), { source: 'WJAFunnelController:moveEncuadre:publish' });
        }
      }

      res.json({ success: true, data: { encuadreId: id, targetStage } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, error: message });
    }
  }

  /**
   * POST /api/admin/vacancies/blocked-applications/:blockedId/reject
   *
   * "Rechazar" um card da coluna BLOQUEADO (soft-dismiss). NÃO cria candidatura: o
   * trigger 183 proíbe WJA de worker não-REGISTERED (e todo bloqueado é não-REGISTERED).
   * Marca a tentativa como rechazada, com motivo — o card sai de BLOQUEADO e aparece em
   * RECHAZADOS como card de bloqueado (não-arrastável). Reversível via undismiss.
   * Escopo estrito à vaga.
   */
  async rejectBlockedApplication(req: Request, res: Response): Promise<void> {
    try {
      const { blockedId } = req.params;
      if (!blockedId || !z.string().uuid().safeParse(blockedId).success) {
        res.status(400).json({ success: false, error: 'blockedId must be a valid UUID' });
        return;
      }

      const { rejectionReasonCategory } = req.body ?? {};
      if (!rejectionReasonCategory || !REJECTION_REASON_CATEGORIES.includes(rejectionReasonCategory)) {
        res.status(400).json({
          success: false,
          error: `rejectionReasonCategory must be one of: ${REJECTION_REASON_CATEGORIES.join(', ')}`,
        });
        return;
      }

      const ok = await this.blockedWriteRepo.dismiss(blockedId, rejectionReasonCategory);
      if (!ok) {
        res.status(404).json({ success: false, error: 'Blocked application not found' });
        return;
      }

      res.json({ success: true, data: { blockedId, dismissedReason: rejectionReasonCategory } });
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)), {
        source: 'WJAFunnelController.rejectBlockedApplication',
      });
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * POST /api/admin/vacancies/blocked-applications/:blockedId/restore
   *
   * "Voltar a bloqueados" — desfaz o rechazo. O card volta de RECHAZADOS para BLOQUEADO
   * (único destino válido para um worker incompleto).
   */
  async undismissBlockedApplication(req: Request, res: Response): Promise<void> {
    try {
      const { blockedId } = req.params;
      if (!blockedId || !z.string().uuid().safeParse(blockedId).success) {
        res.status(400).json({ success: false, error: 'blockedId must be a valid UUID' });
        return;
      }

      const ok = await this.blockedWriteRepo.undismiss(blockedId);
      if (!ok) {
        res.status(404).json({ success: false, error: 'Blocked application not found' });
        return;
      }

      res.json({ success: true, data: { blockedId } });
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)), {
        source: 'WJAFunnelController.undismissBlockedApplication',
      });
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }
}
