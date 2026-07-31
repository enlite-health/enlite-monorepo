import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';
import { formatDateUTC, formatTimeUTC } from '@shared/utils/dateFormatters';
import { PubSubClient } from '@shared/events/PubSubClient';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { GoogleCalendarService } from '@modules/matching';

/**
 * BookSlotFromWhatsAppUseCase — Step 7 do roadmap.
 *
 * Quando o worker toca num botão de slot no WhatsApp:
 *   1. Identifica worker pelo phone (E.164)
 *   2. Busca application pendente (interview_response = 'pending')
 *   3. Mapeia button_payload → meet_link_N da vaga
 *   4. Adiciona ao Google Calendar
 *   5. Atualiza worker_job_applications
 *   6. Enfileira confirmação WhatsApp
 *   7. Agenda Cloud Tasks (24h + 5min antes)
 */
export class BookSlotFromWhatsAppUseCase {
  constructor(
    private readonly db: Pool,
    private readonly pubsub: PubSubClient,
    private readonly cloudTasks: CloudTasksClient,
    private readonly googleCalendarService: GoogleCalendarService,
  ) {}

  async execute(fromPhone: string, buttonPayload: string, originalMessageSid?: string): Promise<Result<void>> {
    // 1. Normalizar phone e identificar worker
    const phone = this.normalizePhone(fromPhone);
    const workerResult = await this.db.query(
      `SELECT id, email FROM workers WHERE phone = $1 LIMIT 1`,
      [phone],
    );

    if (workerResult.rows.length === 0) {
      console.warn(`[BookSlotFromWhatsApp] Worker not found for phone ${phone}`);
      return Result.fail('Worker not found');
    }

    const worker = workerResult.rows[0] as { id: string; email: string | null };

    // 2. Buscar job_posting_id via OriginalRepliedMessageSid (correlação exata)
    //    Fallback para busca por interview_response='pending' se SID não disponível (janela 7 dias)
    let jobPostingId: string | null = null;

    if (originalMessageSid) {
      const outboxResult = await this.db.query(
        `SELECT variables->>'job_posting_id' AS job_posting_id
         FROM messaging_outbox
         WHERE twilio_sid = $1
         LIMIT 1`,
        [originalMessageSid],
      );
      jobPostingId = outboxResult.rows[0]?.job_posting_id ?? null;
    }

    if (!jobPostingId) {
      // Fallback: busca application pendente sem meet_link (ainda não escolheu slot)
      const appResult = await this.db.query(
        `SELECT job_posting_id
         FROM worker_job_applications
         WHERE worker_id = $1
           AND interview_response = 'pending'
           AND interview_meet_link IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
        [worker.id],
      );
      jobPostingId = (appResult.rows[0] as { job_posting_id: string } | undefined)?.job_posting_id ?? null;
    }

    if (!jobPostingId) {
      console.warn(`[BookSlotFromWhatsApp] No pending interview for worker ${worker.id}`);
      return Result.fail('No pending interview');
    }

    const application = { job_posting_id: jobPostingId };

    // 3. Mapear button → meet_link_N
    const slotIndex = parseInt(buttonPayload.replace('slot_', ''), 10);
    if (isNaN(slotIndex) || slotIndex < 1 || slotIndex > 3) {
      return Result.fail('Invalid slot index');
    }

    const vacancyResult = await this.db.query(
      `SELECT meet_link_1, meet_datetime_1,
              meet_link_2, meet_datetime_2,
              meet_link_3, meet_datetime_3
       FROM job_postings
       WHERE id = $1 AND deleted_at IS NULL`,
      [application.job_posting_id],
    );

    if (vacancyResult.rows.length === 0) {
      return Result.fail('Job posting not found');
    }

    const vacancy = vacancyResult.rows[0] as Record<string, string | null>;

    // Fallback: com <3 slots configurados o convite repete o último horário
    // válido nas posições vazias (variável vazia é rejeitada pela Meta), então
    // o botão 2/3 pode apontar pra slot inexistente — e o worker viu um
    // horário REAL na mensagem. Cai no primeiro slot futuro configurado em
    // vez de falhar. Também cobre slot escolhido que já passou (resposta tardia).
    const slotOf = (n: number) => ({
      link: vacancy[`meet_link_${n}`],
      datetime: vacancy[`meet_datetime_${n}`],
    });
    const isBookable = (s: { link: string | null; datetime: string | null }): s is { link: string; datetime: string } =>
      Boolean(s.link && s.datetime && new Date(s.datetime).getTime() > Date.now());

    const chosen = slotOf(slotIndex);
    let effective: { link: string; datetime: string } | undefined = isBookable(chosen) ? chosen : undefined;
    if (!effective) {
      effective = [1, 2, 3].map(slotOf).find(isBookable);
      if (!effective) {
        return Result.fail('Invalid slot');
      }
      console.warn(
        `[BookSlotFromWhatsApp] slot_${slotIndex} inválido/passado para job ${application.job_posting_id} — usando primeiro slot futuro configurado`,
      );
    }
    const meetLink = effective.link;
    const meetDatetime = effective.datetime;

    // 4. Google Calendar — adicionar worker como convidado
    if (worker.email) {
      const calResult = await this.googleCalendarService.addGuestToMeeting(meetLink, worker.email, true, meetDatetime);
      if (calResult.success) {
        console.log(`[BookSlotFromWhatsApp] Calendar invite sent to ${worker.email}`);
      } else {
        console.error(
          `[BookSlotFromWhatsApp] Failed to add ${worker.email} to calendar: ${calResult.reason}${calResult.detail ? ` (${calResult.detail})` : ''}`,
        );
      }
    } else {
      console.warn(`[BookSlotFromWhatsApp] Worker ${worker.id} has no email — skipped calendar invite`);
    }

    // 5. Atualizar worker_job_applications
    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_meet_link       = $1,
           interview_datetime        = $2,
           interview_response        = 'confirmed',
           application_funnel_stage  = 'CONFIRMED',
           updated_at                = NOW()
       WHERE worker_id = $3 AND job_posting_id = $4`,
      [meetLink, meetDatetime, worker.id, application.job_posting_id],
    );

    // 6. Confirmação WhatsApp via outbox — TD-025: dedup atomic
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
        worker.id,
        JSON.stringify({
          date: formatDateUTC(meetDatetime),
          time: formatTimeUTC(meetDatetime),
          job_posting_id: application.job_posting_id,
        }),
        application.job_posting_id,
      ],
    );

    if (outboxResult.rows.length === 0) {
      console.log(`[BookSlotFromWhatsApp] Dedup hit — confirmação já enfileirada nos últimos 5min para worker ${worker.id} / job ${application.job_posting_id}`);
      return Result.ok();
    }

    const outboxId = outboxResult.rows[0].id;
    await this.pubsub.publish('outbox-enqueued', { outboxId });

    // 7. Agendar reminders via Cloud Tasks
    const interviewDate = new Date(meetDatetime);

    await this.cloudTasks.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/qualified',
      body: { workerId: worker.id, jobPostingId: application.job_posting_id },
      scheduleTime: new Date(interviewDate.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    });

    await this.cloudTasks.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/5min',
      body: { workerId: worker.id, jobPostingId: application.job_posting_id },
      scheduleTime: new Date(interviewDate.getTime() - 5 * 60 * 1000).toISOString(),
    });

    console.log(
      `[BookSlotFromWhatsApp] Booked slot_${slotIndex} worker=${worker.id} job=${application.job_posting_id}`,
    );

    return Result.ok();
  }

  /**
   * Remove o prefixo "whatsapp:" do número Twilio inbound.
   * "whatsapp:+5491112345678" → "+5491112345678"
   */
  private normalizePhone(from: string): string {
    return from.replace(/^whatsapp:/, '');
  }
}
