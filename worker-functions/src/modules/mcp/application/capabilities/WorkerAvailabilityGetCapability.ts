import { z } from 'zod';
import type { IAvailabilityRepository } from '../../../worker/ports/IAvailabilityRepository';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerAvailabilityGetCapability (worker.availability.get) — READ.
 *
 * Lê a disponibilidade estruturada REAL do worker (`worker_availability`). Fonte de
 * verdade pra a Luz NÃO afirmar disponibilidade de memória/dossiê (que dessincroniza —
 * achado F2). Reusa o AvailabilityRepository existente.
 */
export class WorkerAvailabilityGetCapability {
  static readonly NAME = 'worker.availability.get';
  static readonly DESCRIPTION =
    'Get the current structured availability (days + time ranges) of a worker from worker_availability.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: IAvailabilityRepository) {}

  async execute(
    args: unknown,
  ): Promise<{ slots: { dayOfWeek: number; startTime: string; endTime: string }[] }> {
    const { workerId } = ArgsSchema.parse(args);
    const result = await this.repo.findByWorkerId(workerId);
    const rows = result.isSuccess ? result.getValue() : [];
    return {
      slots: rows.map((s) => ({
        dayOfWeek: s.dayOfWeek,
        startTime: String(s.startTime).slice(0, 5), // "HH:MM:SS" → "HH:MM"
        endTime: String(s.endTime).slice(0, 5),
      })),
    };
  }
}
