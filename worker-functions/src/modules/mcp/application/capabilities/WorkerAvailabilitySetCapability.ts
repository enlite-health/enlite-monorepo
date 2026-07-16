import { z } from 'zod';
import type { SetWorkerAvailabilityUseCase } from '../../../worker/application/SetWorkerAvailabilityUseCase';

const SlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
  timezone: z.string().optional(),
  crossesMidnight: z.boolean().optional(),
});

const ArgsShape = {
  workerId: z.string().uuid(),
  slots: z.array(SlotSchema).min(1),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerAvailabilitySetCapability (worker.availability.set) — WRITE.
 *
 * A Luz grava a disponibilidade estruturada do worker (substitui, atômico,
 * auditado). Delega ao SetWorkerAvailabilityUseCase. Fecha o gap de "a Luz afirma
 * ter registrado disponibilidade sem gravar".
 */
export class WorkerAvailabilitySetCapability {
  static readonly NAME = 'worker.availability.set';
  static readonly DESCRIPTION =
    'Replace the structured availability (days + time ranges) of a worker in worker_availability. Atomic, audited, rejects empty list.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: SetWorkerAvailabilityUseCase) {}

  async execute(args: unknown): Promise<{ ok: boolean; slots: number; reason?: string }> {
    const { workerId, slots } = ArgsSchema.parse(args);
    const result = await this.useCase.execute({ workerId, slots });
    return result.reason
      ? { ok: result.ok, slots: result.slots, reason: result.reason }
      : { ok: result.ok, slots: result.slots };
  }
}
