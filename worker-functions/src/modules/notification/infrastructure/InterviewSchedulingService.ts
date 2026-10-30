import { Pool } from 'pg';
import { InterviewSlotRepository } from './InterviewSlotRepository';
import {
  InterviewSlot,
  CreateInterviewSlotsDTO,
  BookSlotDTO,
  BookSlotResult,
} from '../domain/InterviewSlot';
import { Result } from '@shared/utils/Result';
import { TokenService } from './TokenService';
import { operationDateOf } from '@shared/locale/civilClock';

export class InterviewSchedulingService {
  private tokenService: TokenService;

  constructor(
    private readonly repository: InterviewSlotRepository,
    private readonly db: Pool,
  ) {
    this.tokenService = new TokenService(db);
  }

  /**
   * Valida que todos os slots têm data futura e delega a criação ao repositório.
   */
  async createSlotsForJob(dto: CreateInterviewSlotsDTO): Promise<InterviewSlot[]> {
    const now = new Date();
    const today = operationDateOf('AR', now);

    for (const slot of dto.slots) {
      if (slot.date < today) {
        throw new Error(`Slot date ${slot.date} is in the past`);
      }
    }

    return this.repository.createSlots(dto);
  }

  /**
   * Reserva um slot para um encuadre.
   * Se sendInvitation=true, enfileira mensagem de convite na messaging_outbox
   * com variáveis tokenizadas para proteger o nome do worker.
   */
  async bookSlot(dto: BookSlotDTO, db: Pool): Promise<Result<BookSlotResult>> {
    const slot = await this.repository.getSlotById(dto.slotId);
    if (!slot) {
      return Result.fail('Slot not found');
    }

    const { success, slot: updatedSlot } = await this.repository.bookSlot(
      dto.slotId,
      dto.encuadreId,
      slot.meetLink,
    );

    if (!success || !updatedSlot) {
      return Result.fail('Slot is no longer available');
    }

    let invitationQueued = false;

    if (dto.sendInvitation !== false) {
      invitationQueued = await this.enqueueInvitation(
        db,
        dto.encuadreId,
        updatedSlot,
      );
    }

    return Result.ok<BookSlotResult>({
      encuadreId:    dto.encuadreId,
      slotId:        updatedSlot.id,
      interviewDate: updatedSlot.slotDate,
      interviewTime: updatedSlot.slotTime,
      meetLink:      updatedSlot.meetLink,
      invitationQueued,
    });
  }

  /**
   * Busca o worker_id do encuadre, tokeniza o nome e insere o convite na outbox.
   * Retorna true se o convite foi enfileirado com sucesso.
   */
  private async enqueueInvitation(
    db: Pool,
    encuadreId: string,
    slot: InterviewSlot,
  ): Promise<boolean> {
    try {
      const encuadreResult = await db.query<{
        worker_id: string | null;
        location: string | null;
      }>(
        `SELECT e.worker_id,
                pa.address_formatted AS location
         FROM encuadres e
         LEFT JOIN job_postings jp ON jp.id = e.job_posting_id
         LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
         WHERE e.id = $1`,
        [encuadreId],
      );

      if (encuadreResult.rows.length === 0) return false;

      const { worker_id, location } = encuadreResult.rows[0];
      if (!worker_id) return false;

      // Tokeniza o nome para proteger PII na outbox
      const nameToken = await this.tokenService.generate(worker_id, 'worker_first_name');

      const dateFormatted = new Date(slot.slotDate).toLocaleDateString('es-AR', {
        timeZone: 'UTC',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });

      const variables = {
        name:      nameToken,
        date:      dateFormatted,
        time:      slot.slotTime,
        meet_link: slot.meetLink ?? '',
        location:  location ?? '',
      };

      await db.query(
        `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
         VALUES ($1, $2, $3::jsonb, 'pending', 0)`,
        [worker_id, 'encuadre_invitation', JSON.stringify(variables)],
      );

      return true;
    } catch (err) {
      console.error('[InterviewSchedulingService] Erro ao enfileirar convite:', err);
      return false;
    }
  }
}
