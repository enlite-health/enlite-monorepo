import { z } from 'zod';
import type { BookInterviewSlotUseCase } from '../../../notification/application/BookInterviewSlotUseCase';
import type { BookInterviewSlotResult } from '../../../notification/application/BookInterviewSlotUseCase';
import type { GetWorkerByIdUseCase } from '../../../worker/application/GetWorkerByIdUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
  jobPostingId: z.string().uuid(),
  slotIndex: z.number().int().min(1).max(3),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerInterviewBookCapability (worker.interview.book) — WRITE.
 *
 * Agenda a entrevista do worker na vaga (mesmo miolo do fluxo por botão:
 * BookInterviewSlotUseCase). Pré-condição dura no servidor: QUALIFIED +
 * interview_response='pending' (fora de estado → {ok:false, reason}; repetido →
 * 'already_booked'). Retorna confirmedDate/confirmedTime/calendarInvite
 * EXPLÍCITOS — os fatos que a resposta da Luz cita e o notário verifica.
 */
export class WorkerInterviewBookCapability {
  static readonly NAME = 'worker.interview.book';
  static readonly DESCRIPTION =
    "Book the interview slot (1-3) of a vacancy for a QUALIFIED worker with pending interview response. Sends Calendar invite, confirms funnel stage, queues WhatsApp confirmation and reminders. Returns explicit {confirmedDate, confirmedTime, calendarInvite}; out-of-state returns {ok:false, reason} ('not_qualified' | 'already_booked' | ...). Never fabricates times: quote ONLY the returned values.";
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(
    private readonly bookInterviewSlot: BookInterviewSlotUseCase,
    private readonly getWorkerById: GetWorkerByIdUseCase,
  ) {}

  async execute(args: unknown): Promise<BookInterviewSlotResult> {
    const { workerId, jobPostingId, slotIndex } = ArgsSchema.parse(args);

    // Email decriptado p/ o convite de Calendar; sem email o agendamento segue
    // (calendarInvite='no_email' — a Luz comunica a ressalva).
    let workerEmail: string | null = null;
    try {
      const { worker } = await this.getWorkerById.execute(workerId);
      workerEmail = worker.email || null;
    } catch {
      /* segue sem email */
    }

    return this.bookInterviewSlot.execute({ workerId, workerEmail, jobPostingId, slotIndex });
  }
}
