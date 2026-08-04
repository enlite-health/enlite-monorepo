import { Pool } from 'pg';
import { formatDateUTC, formatTimeUTC } from '@shared/utils/dateFormatters';
import { PubSubClient } from '@shared/events/PubSubClient';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { GoogleCalendarService } from '@modules/matching';

/** Desfecho do convite de Calendar, propagado ao caller (o BookSlot antigo só logava). */
export type CalendarInviteOutcome =
  | 'sent'
  | 'no_email'
  | 'already_invited'
  | 'event_not_found'
  | 'auth_error'
  | 'api_error'
  | 'invalid_link'
  | 'invalid_email';

export interface BookInterviewSlotParams {
  workerId: string;
  /** Email do worker (null → pula o convite de Calendar, agendamento segue). */
  workerEmail: string | null;
  jobPostingId: string;
  /** 1..3 — posição do meet_link_N/meet_datetime_N na vaga. */
  slotIndex: number;
}

export type BookInterviewSlotResult =
  | {
      ok: true;
      /** dd/MM e HH:mm (UTC) — os MESMOS formatos da confirmação WhatsApp. */
      confirmedDate: string;
      confirmedTime: string;
      /** ISO do slot efetivamente agendado (pode diferir do pedido — fallback de slot). */
      meetDatetime: string;
      usedSlotIndex: number;
      calendarInvite: CalendarInviteOutcome;
    }
  | {
      ok: false;
      reason: 'application_not_found' | 'already_booked' | 'not_qualified' | 'invalid_slot' | 'job_not_found';
    };

/**
 * BookInterviewSlotUseCase — miolo do agendamento de entrevista, extraído do
 * BookSlotFromWhatsAppUseCase (que agora delega). Independente de canal:
 * recebe worker/vaga/slot resolvidos e executa slots → Calendar → WJA →
 * confirmação (outbox, dedup 5min) → lembretes (Cloud Tasks).
 *
 * Pré-condição EXPLÍCITA (nova em relação ao fluxo por botão, onde o estado
 * era garantido por só-qualificado-recebe-template): a candidatura precisa
 * estar QUALIFIED com interview_response='pending'. Fora de estado → {ok:false,
 * reason} determinístico; nunca lança.
 */
export class BookInterviewSlotUseCase {
  constructor(
    private readonly db: Pool,
    private readonly pubsub: PubSubClient,
    private readonly cloudTasks: CloudTasksClient,
    private readonly googleCalendarService: GoogleCalendarService,
  ) {}

  async execute(params: BookInterviewSlotParams): Promise<BookInterviewSlotResult> {
    const { workerId, workerEmail, jobPostingId, slotIndex } = params;

    if (!Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > 3) {
      return { ok: false, reason: 'invalid_slot' };
    }

    // Pré-condição de estado (guard)
    const stateResult = await this.db.query(
      `SELECT application_funnel_stage, interview_response
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2
       LIMIT 1`,
      [workerId, jobPostingId],
    );

    if (stateResult.rows.length === 0) {
      return { ok: false, reason: 'application_not_found' };
    }

    const state = stateResult.rows[0] as {
      application_funnel_stage: string | null;
      interview_response: string | null;
    };

    if (state.interview_response === 'confirmed') {
      return { ok: false, reason: 'already_booked' };
    }

    if (state.application_funnel_stage !== 'QUALIFIED' || state.interview_response !== 'pending') {
      return { ok: false, reason: 'not_qualified' };
    }

    const vacancyResult = await this.db.query(
      `SELECT meet_link_1, meet_datetime_1,
              meet_link_2, meet_datetime_2,
              meet_link_3, meet_datetime_3
       FROM job_postings
       WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );

    if (vacancyResult.rows.length === 0) {
      return { ok: false, reason: 'job_not_found' };
    }

    const vacancy = vacancyResult.rows[0] as Record<string, string | null>;

    // Fallback: com <3 slots configurados o convite repete o último horário
    // válido nas posições vazias (variável vazia é rejeitada pela Meta), então
    // o botão 2/3 pode apontar pra slot inexistente — e o worker viu um
    // horário REAL na mensagem. Cai no primeiro slot futuro configurado em
    // vez de falhar. Também cobre slot escolhido que já passou (resposta tardia).
    const slotOf = (n: number) => ({
      index: n,
      link: vacancy[`meet_link_${n}`],
      datetime: vacancy[`meet_datetime_${n}`],
    });
    const isBookable = (
      s: { index: number; link: string | null; datetime: string | null },
    ): s is { index: number; link: string; datetime: string } =>
      Boolean(s.link && s.datetime && new Date(s.datetime).getTime() > Date.now());

    const chosen = slotOf(slotIndex);
    let effective: { index: number; link: string; datetime: string } | undefined =
      isBookable(chosen) ? chosen : undefined;
    if (!effective) {
      effective = [1, 2, 3].map(slotOf).find(isBookable);
      if (!effective) {
        return { ok: false, reason: 'invalid_slot' };
      }
      console.warn(
        `[BookInterviewSlot] slot_${slotIndex} inválido/passado para job ${jobPostingId} — usando primeiro slot futuro configurado`,
      );
    }
    const meetLink = effective.link;
    const meetDatetime = effective.datetime;

    // Google Calendar — adicionar worker como convidado (resultado propagado)
    let calendarInvite: CalendarInviteOutcome;
    if (workerEmail) {
      const calResult = await this.googleCalendarService.addGuestToMeeting(meetLink, workerEmail, true, meetDatetime);
      if (calResult.success) {
        console.log(`[BookInterviewSlot] Calendar invite sent to ${workerEmail}`);
        calendarInvite = 'sent';
      } else {
        console.error(
          `[BookInterviewSlot] Failed to add ${workerEmail} to calendar: ${calResult.reason}${calResult.detail ? ` (${calResult.detail})` : ''}`,
        );
        calendarInvite = calResult.reason;
      }
    } else {
      console.warn(`[BookInterviewSlot] Worker ${workerId} has no email — skipped calendar invite`);
      calendarInvite = 'no_email';
    }

    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_meet_link       = $1,
           interview_datetime        = $2,
           interview_response        = 'confirmed',
           application_funnel_stage  = 'CONFIRMED',
           updated_at                = NOW()
       WHERE worker_id = $3 AND job_posting_id = $4`,
      [meetLink, meetDatetime, workerId, jobPostingId],
    );

    const confirmedDate = formatDateUTC(meetDatetime);
    const confirmedTime = formatTimeUTC(meetDatetime);
    const okResult: BookInterviewSlotResult = {
      ok: true,
      confirmedDate,
      confirmedTime,
      meetDatetime,
      usedSlotIndex: effective.index,
      calendarInvite,
    };

    // Confirmação WhatsApp via outbox — TD-025: dedup atomic
    //    Webhook Twilio pode entregar a mesma resposta múltiplas vezes; usuário
    //    pode tocar no botão repetidas vezes. NOT EXISTS evita N confirmações
    //    idênticas pra mesma vaga em janela curta (5min).
    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       SELECT $1, 'qualified_worker_response', $2::jsonb, 'pending', 0
       WHERE NOT EXISTS (
         SELECT 1 FROM messaging_outbox
         WHERE worker_id = $1
           AND template_slug = 'qualified_worker_response'
           AND status IN ('pending', 'sent')
           AND created_at > NOW() - INTERVAL '5 minutes'
           AND variables->>'job_posting_id' = $3
       )
       RETURNING id`,
      [
        workerId,
        JSON.stringify({
          date: confirmedDate,
          time: confirmedTime,
          job_posting_id: jobPostingId,
        }),
        jobPostingId,
      ],
    );

    if (outboxResult.rows.length === 0) {
      console.log(`[BookInterviewSlot] Dedup hit — confirmação já enfileirada nos últimos 5min para worker ${workerId} / job ${jobPostingId}`);
      return okResult;
    }

    const outboxId = outboxResult.rows[0].id;
    await this.pubsub.publish('outbox-enqueued', { outboxId });

    // Lembretes via Cloud Tasks
    const interviewDate = new Date(meetDatetime);

    await this.cloudTasks.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/qualified',
      body: { workerId, jobPostingId },
      scheduleTime: new Date(interviewDate.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    });

    await this.cloudTasks.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/5min',
      body: { workerId, jobPostingId },
      scheduleTime: new Date(interviewDate.getTime() - 5 * 60 * 1000).toISOString(),
    });

    return okResult;
  }
}
