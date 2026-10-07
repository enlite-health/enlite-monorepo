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
import { BlockedApplicationQueryRepository, wjaSupersededByBlockedSql } from '../../infrastructure/BlockedApplicationQueryRepository';
import { BlockedApplicationRepository } from '../../infrastructure/BlockedApplicationRepository';
import { deriveKanbanColumn, kanbanColumnForBlocked, KanbanColumn } from '../../domain/kanbanColumn';
import {
  interviewScheduleSchema,
  interviewDatetimeSql,
  INTERVIEW_DATE_RESOLVED_SQL,
  INTERVIEW_TIME_RESOLVED_SQL,
} from '../../domain/interviewSchedule';
import { REJECTION_REASON_CATEGORIES } from '../../domain/Encuadre';
import { cellsOfRequest, projectWorkerFields, NOME_REDIGIDO, podeVerCandidatoDoMatch } from '@modules/identity/permissions';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { RESEND_COOLDOWN_HOURS, resendCooldownUntilSql } from '../../../notification/application/VacancyInviteGuard';
import { PubSubClient } from '@shared/events/PubSubClient';
import { emitFunnelStageEvent, isFunnelStage, MOVABLE_FUNNEL_STAGES, isMovableFunnelStage } from '../../application/FunnelStageEventEmitter';
import { candidateDistanceKmSql } from '../../infrastructure/candidateDistanceSql';
import {
  requiredMoveReason,
  isAllowedMoveReason,
  MoveReasonRequiredError,
  MoveReasonInvalidError,
  compatibleMoveRefusal,
  CompatibleReadOnlyError,
  type CompatibleRefusal,
} from '../../domain/moveReason';

/**
 * Papel opcional ao mover para SELECTED (feature "Equipe Armada").
 * TITULAR=titular, RAPID_RESPONSE=substituto. Ausente = fica pendente de
 * classificação (bucket PENDENTE_CLASSIFICACAO no dashboard de gestão).
 */
const encuadreRoleSchema = z.enum(['TITULAR', 'RAPID_RESPONSE']);

/**
 * 422 `COMPATIBLE_READ_ONLY` — corpo montado uma única vez (achado 🟡-7 do gate parcial 1:
 * o mesmo objeto de 5 campos era escrito duas vezes em `moveEncuadre`, uma para a recusa
 * de ENTRADA em Compatíveis — antes de qualquer query — e outra para a recusa de SAÍDA
 * rumo a Invitados sem envio, capturada no catch de `CompatibleReadOnlyError`). Contrato
 * da resposta inalterado: `{ success:false, error:'compatible_read_only',
 * code:'COMPATIBLE_READ_ONLY', reason }`.
 */
function sendCompatibleReadOnly(res: Response, reason: CompatibleRefusal): void {
  res.status(422).json({
    success: false,
    error: 'compatible_read_only',
    code: 'COMPATIBLE_READ_ONLY',
    reason,
  });
}

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
 * kanbanColumnForBlocked). Promoted (worker completed registration)
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
   *   REJECTED   — inclui tentativas negadas DISPENSADAS não promovidas (D474)
   *   INICIADO   — WJA stage=INVITED + source='manual' (postulação real) + tentativas negadas ativas (D474)
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
             wsa.work_zone,
             ${candidateDistanceKmSql('wja.worker_id', 'wja.job_posting_id')} AS distance_km
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
           -- Uma área por WJA (043 A4): com a junção direta, quem tem 2+ áreas duplicava o
           -- card e o total do funil passava o counts.columns da funnel-table. Convenção do repo
           -- (BackfillWorkerMirrorUseCase): a mais antiga é a principal; o id desempata.
           LEFT JOIN LATERAL (
             SELECT work_zone
             FROM worker_service_areas
             WHERE worker_id = wja.worker_id AND deleted_at IS NULL
             ORDER BY created_at ASC, id ASC
             LIMIT 1
           ) wsa ON true
           WHERE wja.job_posting_id = $1
             -- worker que deu baixa na conta não pode aparecer no kanban da vaga
             -- (mesmo recorte de FunnelTableRepository/VacancyMatchController)
             AND ${excludeDisabledWorkersSql('w')}
             -- M6b (D474): o convite do sistema some quando o par tem tentativa bloqueada;
             -- o card que fica é o bloqueado (blockedAttempts), em Iniciados.
             AND NOT ${wjaSupersededByBlockedSql('wja')}
           ORDER BY wja.updated_at DESC NULLS LAST, wja.created_at DESC`,
          [id, RESEND_COOLDOWN_HOURS],
        ),
        this.blockedRepo.listByVacancy(id),
      ]);

      // Colunas do Kanban — classificação 100% baseada em application_funnel_stage
      // Migration 230: INITIATED removido → PRE_SCREENING + INICIADO adicionados
      // Feature BLOQUEADO: tentativas negadas → Iniciados (dispensadas → Rejeitados), D474
      const stages: Record<string, unknown[]> = {
        COMPATIBLE: [], // Fase 5 (D432): candidato do match nunca mensageado
        INVITED: [],
        INICIADO: [],       // INVITED+source='manual' — postulação real, não-bloqueada
        PRE_SCREENING: [],  // Antigo INITIATED — entrou no formulário Talentum
        IN_PROGRESS: [],
        COMPLETED: [],      // agrupa COMPLETED + QUALIFIED + IN_DOUBT (tag diferencia)
        CONFIRMED: [],
        SELECTED: [],
        QUICK_RESPONSE_TEAM: [], // Fase 4 (D430) — destino do arrasto manual, entrada do quadro C
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
        Promise.all(result.rows.map(async (row): Promise<{
          name: string;
          phone: string | null;
          column: KanbanColumn;
          matchRedigido: boolean;
        }> => {
          // Fase 5 (D432): a coluna decide ANTES da projeção — Compatíveis sem
          // `match:read` nem chama projectWorkerFields (zero KMS), mesmo padrão
          // do F2/C3 pra worker_contact:read.
          const column = deriveKanbanColumn(
            row.funnel_stage as string | null,
            row.source as string | null,
            row.messaged_at as string | Date | null,
          );
          if (column === 'COMPATIBLE' && !podeVerCandidatoDoMatch(cells)) {
            return { name: NOME_REDIGIDO, phone: null, column, matchRedigido: true };
          }
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
          return { name, phone: visivel.phone ?? null, column, matchRedigido: false };
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
        const { column, matchRedigido } = visiveisWja[i];

        // Fase 5 (D432): Compatíveis (candidato do match nunca mensageado) entra
        // no quadro, mas não conta em "N encuadres" (o subtítulo continua sendo
        // só os WJAs de verdade — D437).
        if (column !== 'COMPATIBLE') {
          classifiedCount++;
        }

        const item = {
          id: row.id,
          // Compatíveis sem `match:read`: sem encuadreId (sem arrasto, sem menu,
          // sem notas) e sem workerId (nada foi revelado — DX-5.7).
          encuadreId: matchRedigido ? null : (row.encuadre_id ?? null),
          workerId: matchRedigido ? null : (row.worker_id ?? null),
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
          distanceKm: row.distance_km == null ? null : Number(row.distance_km),
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

        // Classificação 100% baseada em (stage, source, messagedAt) — SSOT em
        // deriveKanbanColumn (domain/kanbanColumn.ts), compartilhado com a aba de
        // encuadre do worker-detail. `column` já foi calculada acima, junto da
        // projeção (a coluna decide se o nome pode sair).
        stages[column].push(item);
      }

      // Merge blocked attempt cards. Tentativa negada → Iniciados (D474), ou Rejeitados
      // quando dispensada (kanbanColumnForBlocked), como card de bloqueado
      // (não-arrastável, encuadreId null — coerente: um incompleto não pode ter WJA
      // nem andar no funil). listByVacancy já faz NOT EXISTS contra
      // worker_job_applications, então um bloqueado promovido vira WJA real e some
      // daqui automaticamente.
      for (let i = 0; i < blockedAttempts.length; i++) {
        const ba = blockedAttempts[i];
        const blockedWorker = decryptedBlockedNames[i];
        const isDismissed = ba.dismissedAt != null;
        stages[kanbanColumnForBlocked(isDismissed)].push({
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
          distanceKm: null,
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
          totalEncuadres: classifiedCount, // cards do funil, SEM os de Compatíveis (subtítulo do quadro)
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
   * Body: { targetStage, reasonCategory?, rejectionReason?, role?,
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
   *
   * Fase 4 (D430/D434, invariante 11): salto de etapa e entrar/sair de Rejeitados exigem
   * `reasonCategory` — a regra mora em `WF/domain/moveReason.ts` (requiredMoveReason),
   * este método só chama. Sem motivo ou motivo fora da lista do tipo → 422
   * (MOVE_REASON_REQUIRED / MOVE_REASON_INVALID) DENTRO da transação, antes de qualquer
   * escrita — a checagem roda antes do upsert, então nada é gravado quando recusa.
   * `targetStage` aceita QUICK_RESPONSE_TEAM (MOVABLE_FUNNEL_STAGES) — é movível mas não
   * mensageável (DX-4.7): `emitFunnelStageEvent` só roda para as etapas de `isFunnelStage`.
   *
   * Fase 5 (DX-5.5/DX-5.6, D432): Compatíveis é coluna DERIVADA (candidato do match nunca
   * mensageado, `WF/domain/kanbanColumn.ts`) — nunca um valor de `application_funnel_stage`,
   * então nunca é destino MOVÍVEL de verdade. `compatibleMoveRefusal` (`moveReason.ts`) recusa
   * com 422 `COMPATIBLE_READ_ONLY`: entrar em Compatíveis (`targetStage === 'COMPATIBLE'`,
   * checado ANTES de qualquer leitura de banco — nem chega a `isMovableFunnelStage`) e sair de
   * Compatíveis para Invitados por arrasto (virar convidado é ter sido MENSAGEADO, não
   * arrastado — checado DENTRO da transação, com `messaged_at` da origem, antes de
   * `requiredMoveReason`). As demais saídas de Compatíveis (Rejeitados, salto) seguem a regra
   * de motivo de sempre.
   */
  async moveEncuadre(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { targetStage, reasonCategory, rejectionReason, role } = req.body;

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

      // Fase 5 (DX-5.5): Compatíveis nunca é destino de arrasto — checado ANTES de
      // isMovableFunnelStage e antes de qualquer leitura de banco (não é estágio, não há
      // encuadre nem worker a buscar para recusar isto).
      if (compatibleMoveRefusal(null, targetStage) === 'ENTER') {
        sendCompatibleReadOnly(res, 'ENTER');
        return;
      }

      if (!isMovableFunnelStage(targetStage)) {
        res.status(400).json({ success: false, error: `targetStage must be one of: ${MOVABLE_FUNNEL_STAGES.join(', ')}` });
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
        const prev = await client.query<{
          application_funnel_stage: string | null;
          source: string | null;
          messaged_at: string | Date | null;
        }>(
          `SELECT application_funnel_stage, source, messaged_at FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
          [workerId, jobPostingId],
        );
        const previousStage = prev.rows[0]?.application_funnel_stage ?? null;
        const previousSource = prev.rows[0]?.source ?? null;
        const previousMessagedAt = prev.rows[0]?.messaged_at ?? null;
        const origin = prev.rows[0]
          ? { stage: previousStage, source: previousSource, messagedAt: previousMessagedAt }
          : null;

        // Fase 5 (DX-5.6): sair de Compatíveis para Invitados por arrasto é recusado — virar
        // convidado é ter sido MENSAGEADO (messaged_at), nunca arrastado. Roda ANTES de
        // requiredMoveReason: para Compatíveis → Invitados aquela devolveria `null` (etapa
        // igual, INVITED sobre INVITED) e o upsert seria um 200 que não muda nada.
        const compatibleRefusal = compatibleMoveRefusal(origin, targetStage);
        if (compatibleRefusal) {
          throw new CompatibleReadOnlyError(compatibleRefusal);
        }

        // Fase 4 (DX-4.6): a checagem roda DENTRO da transação, ANTES do upsert —
        // se recusar, o catch externo faz ROLLBACK (actorContext.ts) e nada é escrito.
        const moveReasonKind = requiredMoveReason(origin, targetStage);
        if (moveReasonKind) {
          if (reasonCategory === undefined || reasonCategory === null) {
            throw new MoveReasonRequiredError(moveReasonKind);
          }
          if (!isAllowedMoveReason(moveReasonKind, reasonCategory)) {
            throw new MoveReasonInvalidError(moveReasonKind);
          }
          // Lido pelo gatilho da trilha (migration 478, NULLIF) — carimba o motivo na
          // MESMA transação, antes do upsert. Interceptado pelo poolMockSupport nos
          // unit tests (regex de controle de transação): não é observável por mock,
          // só no e2e com banco real.
          await client.query(`SELECT set_config('app.move_reason', $1, true)`, [reasonCategory]);
        }

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
            [id, reasonCategory ?? null, rejectionReason ?? null],
          );
        }

        // DX-4.7: QUICK_RESPONSE_TEAM é movível mas não vira evento (sem mensagem
        // de propósito) — só as etapas de FUNNEL_STAGES emitem.
        stageEventId = isFunnelStage(targetStage)
          ? await emitFunnelStageEvent(client, {
              workerId, jobPostingId, previousStage, targetStage, actorUid, source: 'kanban',
            })
          : null;
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
      // Fase 5 (DX-5.6): sair de Compatíveis para Invitados por arrasto — 422 antes dos
      // de motivo (a recusa da coluna derivada vem primeiro). ROLLBACK já rodou, nada escrito.
      if (error instanceof CompatibleReadOnlyError) {
        sendCompatibleReadOnly(res, error.reason);
        return;
      }
      // Fase 4 (DX-4.6): as duas classes de motivo viram 422 — checadas ANTES do
      // catch genérico. A transação já fez ROLLBACK (withActorContext) quando o
      // erro saiu do bloco acima; nada foi escrito.
      if (error instanceof MoveReasonRequiredError) {
        res.status(422).json({
          success: false,
          error: 'move_reason_required',
          code: 'MOVE_REASON_REQUIRED',
          reason: error.kind,
        });
        return;
      }
      if (error instanceof MoveReasonInvalidError) {
        res.status(422).json({
          success: false,
          error: 'move_reason_invalid',
          code: 'MOVE_REASON_INVALID',
          reason: error.kind,
        });
        return;
      }
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
