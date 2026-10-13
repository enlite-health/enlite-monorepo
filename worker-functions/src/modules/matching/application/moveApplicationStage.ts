import type { PoolClient } from 'pg';
import { interviewDatetimeSql } from '../domain/interviewSchedule';
import { emitFunnelStageEvent, isFunnelStage } from './FunnelStageEventEmitter';
import {
  requiredMoveReason,
  isAllowedMoveReason,
  compatibleMoveRefusal,
  type CompatibleRefusal,
  type MoveReasonKind,
} from '../domain/moveReason';

/**
 * moveApplicationStage — o MIOLO da mudança de estágio da candidatura (spec 052, T-30a).
 *
 * Movimento puro: é exatamente o que rodava dentro da transação de
 * `WJAFunnelController.moveEncuadre` (ler a etapa anterior, recusas de Compatíveis,
 * checagem e carimbo do motivo, upsert da candidatura, `UPDATE encuadres` de SELECTED e
 * REJECTED, emissão do evento de etapa). Roda no `client` da transação de quem chama
 * (`withActorContext`), não conhece `req`/`res` e NÃO publica no Pub/Sub — quem chama
 * publica `eventId` depois do COMMIT.
 *
 * Recusa = resultado `moved: false` ANTES de qualquer escrita. Quem chama decide como
 * traduzir (o controller do funil relança como erro dentro da transação, para o ROLLBACK
 * de sempre, e responde 422).
 */

export interface MoveApplicationStageInput {
  workerId: string;
  jobPostingId: string;
  /**
   * Id do `encuadre` que recebe o resultado em SELECTED/REJECTED. `null` = o par não tem encuadre (candidatura sem ficha):
   * os `UPDATE encuadres` são pulados, todo o resto é igual (spec 052: o evento de enquadre move quem pode não ter encuadre).
   */
  encuadreId: string | null;
  /** Destino já validado como movível por quem chama. */
  targetStage: string;
  actorUid: string | null;
  reasonCategory?: unknown;
  rejectionReason?: unknown;
  /** Papel ao selecionar; `null`/ausente preserva o existente (COALESCE). */
  role?: 'TITULAR' | 'RAPID_RESPONSE' | null;
  interviewDate?: string | null;
  interviewTime?: string | null;
  interviewMeetLink?: string | null;
}

export interface MoveApplicationStageOptions {
  /** `true`: o motivo `JUMP` não é exigido. NÃO afeta ENTER_REJECTED nem LEAVE_REJECTED. */
  skipJumpReason?: boolean;
  /** Origem gravada no payload do evento de etapa. Default `'kanban'`. */
  eventSource?: 'kanban' | 'enquadre';
}

export type MoveApplicationStageResult =
  | { moved: true; previousStage: string | null; eventId: string | null }
  | { moved: false; code: 'COMPATIBLE_READ_ONLY'; reason: CompatibleRefusal }
  | { moved: false; code: 'MOVE_REASON_REQUIRED' | 'MOVE_REASON_INVALID'; reason: MoveReasonKind };

export async function moveApplicationStage(
  client: PoolClient,
  input: MoveApplicationStageInput,
  options: MoveApplicationStageOptions = {},
): Promise<MoveApplicationStageResult> {
  const { workerId, jobPostingId, encuadreId, targetStage, actorUid, reasonCategory, rejectionReason } = input;
  const selectedRole = input.role ?? null;
  const { interviewDate, interviewTime, interviewMeetLink } = input;

  // A conversão para timestamptz é feita pelo Postgres a partir do fuso da OPERAÇÃO
  // (interviewDatetimeSql) — nunca do fuso do navegador de quem arrastou o card.
  //
  // SQL ESTÁTICO de propósito: os placeholders $4/$5 são SEMPRE referenciados, com
  // CASE null-safe (sem isso: "could not determine data type of parameter $4" → 500
  // em TODO movimento sem data; mocks de db.query não veem isso).
  const datetimeInsertSql = `CASE WHEN $4::date IS NULL THEN NULL ELSE ${interviewDatetimeSql('$4', '$5')} END`;
  // No conflito, mover sem data NÃO apaga um agendamento já gravado.
  const datetimeUpdateSql = `CASE WHEN $4::date IS NULL THEN worker_job_applications.interview_datetime ELSE ${interviewDatetimeSql('$4', '$5')} END`;

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
    return { moved: false, code: 'COMPATIBLE_READ_ONLY', reason: compatibleRefusal };
  }

  // Fase 4 (DX-4.6): a checagem roda ANTES do upsert — se recusar, nada é escrito.
  let moveReasonKind = requiredMoveReason(origin, targetStage);
  if (options.skipJumpReason && moveReasonKind === 'JUMP') moveReasonKind = null;
  if (moveReasonKind) {
    if (reasonCategory === undefined || reasonCategory === null) {
      return { moved: false, code: 'MOVE_REASON_REQUIRED', reason: moveReasonKind };
    }
    if (!isAllowedMoveReason(moveReasonKind, reasonCategory)) {
      return { moved: false, code: 'MOVE_REASON_INVALID', reason: moveReasonKind };
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

  // Sincronizar encuadre.resultado para estados terminais
  if (encuadreId === null) {
    // sem encuadre: nada a sincronizar
  } else if (targetStage === 'SELECTED') {
    // Grava o papel quando informado; sem papel o COALESCE preserva o
    // existente (re-mover não apaga a classificação anterior). Encuadre
    // selecionado sem papel = PENDENTE_CLASSIFICACAO no dashboard.
    await client.query(
      `UPDATE encuadres SET resultado = 'SELECCIONADO', role = COALESCE($2, role), updated_at = NOW() WHERE id = $1`,
      [encuadreId, selectedRole],
    );
  } else if (targetStage === 'REJECTED') {
    await client.query(
      `UPDATE encuadres SET resultado = 'RECHAZADO',
         rejection_reason_category = COALESCE($2, rejection_reason_category),
         rejection_reason = COALESCE($3, rejection_reason),
         updated_at = NOW()
       WHERE id = $1`,
      [encuadreId, reasonCategory ?? null, rejectionReason ?? null],
    );
  }

  // DX-4.7: QUICK_RESPONSE_TEAM é movível mas não vira evento (sem mensagem
  // de propósito) — só as etapas de FUNNEL_STAGES emitem.
  const eventId = isFunnelStage(targetStage)
    ? await emitFunnelStageEvent(client, {
        workerId, jobPostingId, previousStage, targetStage, actorUid,
        source: options.eventSource ?? 'kanban',
      })
    : null;

  return { moved: true, previousStage, eventId };
}
