import { Pool } from 'pg';
import { maskPhoneForLog } from '@shared/utils/phoneMask';
import { Result } from '@shared/utils/Result';
import { PubSubClient } from '@shared/events/PubSubClient';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { GoogleCalendarService } from '@modules/matching';
import { BookInterviewSlotUseCase } from './BookInterviewSlotUseCase';

/**
 * BookSlotFromWhatsAppUseCase — Step 7 do roadmap.
 *
 * Camada de CANAL do agendamento por botão do WhatsApp:
 *   1. Identifica worker pelo phone (E.164)
 *   2. Resolve a vaga (OriginalRepliedMessageSid → outbox; fallback pendente)
 *   3. Mapeia button_payload → slotIndex
 *   4. Delega o agendamento ao BookInterviewSlotUseCase (miolo extraído)
 */
export class BookSlotFromWhatsAppUseCase {
  private readonly bookInterviewSlot: BookInterviewSlotUseCase;

  constructor(
    private readonly db: Pool,
    pubsub: PubSubClient,
    cloudTasks: CloudTasksClient,
    googleCalendarService: GoogleCalendarService,
  ) {
    this.bookInterviewSlot = new BookInterviewSlotUseCase(db, pubsub, cloudTasks, googleCalendarService);
  }

  async execute(fromPhone: string, buttonPayload: string, originalMessageSid?: string): Promise<Result<void>> {
    // 1. Normalizar phone e identificar worker
    const phone = this.normalizePhone(fromPhone);
    const workerResult = await this.db.query(
      `SELECT id, email FROM workers WHERE phone = $1 LIMIT 1`,
      [phone],
    );

    if (workerResult.rows.length === 0) {
      console.warn(`[BookSlotFromWhatsApp] Worker not found for phone ${maskPhoneForLog(phone)}`);
      return Result.fail('Worker not found');
    }

    const worker = workerResult.rows[0] as { id: string; email: string | null };

    // 2. Buscar job_posting_id via OriginalRepliedMessageSid (correlação exata)
    //    Fallback para busca por interview_response='pending' se SID não disponível (janela 7 dias)
    let jobPostingId: string | null = null;
    // Hora em que a oferta foi montada: o botão N aponta para a N-ésima opção
    // DAQUELA oferta (slot recorrente anda com o tempo — mig 291).
    let offeredAt: Date | undefined;

    if (originalMessageSid) {
      const outboxResult = await this.db.query(
        `SELECT variables->>'job_posting_id' AS job_posting_id, created_at
         FROM messaging_outbox
         WHERE twilio_sid = $1
         LIMIT 1`,
        [originalMessageSid],
      );
      jobPostingId = outboxResult.rows[0]?.job_posting_id ?? null;
      const createdAt = outboxResult.rows[0]?.created_at as string | Date | undefined;
      if (createdAt) offeredAt = new Date(createdAt);
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

    // 3. Mapear button → slotIndex
    const slotIndex = parseInt(buttonPayload.replace('slot_', ''), 10);
    if (isNaN(slotIndex) || slotIndex < 1 || slotIndex > 3) {
      return Result.fail('Invalid slot index');
    }

    // 4. Delegar ao miolo
    const booking = await this.bookInterviewSlot.execute({
      workerId: worker.id,
      workerEmail: worker.email,
      jobPostingId,
      slotIndex,
      offeredAt,
    });

    if (!booking.ok) {
      switch (booking.reason) {
        case 'already_booked':
          // Toque repetido no botão: a entrevista já está confirmada — idempotente
          // (antes da extração o dedup da outbox absorvia; o guard resolve mais cedo).
          console.log(`[BookSlotFromWhatsApp] Already booked worker=${worker.id} job=${jobPostingId} — ignoring repeat tap`);
          return Result.ok();
        case 'job_not_found':
          return Result.fail('Job posting not found');
        case 'invalid_slot':
          return Result.fail('Invalid slot');
        default:
          // application_not_found | not_qualified — sem candidatura em estado agendável
          return Result.fail('No pending interview');
      }
    }

    console.log(
      `[BookSlotFromWhatsApp] Booked slot_${slotIndex} worker=${worker.id} job=${jobPostingId}`,
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
