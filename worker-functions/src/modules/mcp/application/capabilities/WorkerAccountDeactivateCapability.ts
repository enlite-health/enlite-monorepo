import { z } from 'zod';
import type { DeactivateWorkerAccountUseCase } from '../../../worker/application/DeactivateWorkerAccountUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerAccountDeactivateCapability (worker.account.deactivate) — WRITE.
 *
 * A Luz dá baixa na CONTA do worker que pediu (LGPD): desativa (status=DISABLED,
 * reversível + auditado) e registra o opt-out junto. Delega ao
 * DeactivateWorkerAccountUseCase. `source` fixo = 'luz_conversation'.
 */
export class WorkerAccountDeactivateCapability {
  static readonly NAME = 'worker.account.deactivate';
  static readonly DESCRIPTION =
    'Deactivate (dar de baja) a worker account at the worker request: sets status DISABLED (reversible, audited) and registers the messaging opt-out. Does NOT erase data.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: DeactivateWorkerAccountUseCase) {}

  async execute(args: unknown): Promise<{ ok: boolean; alreadyDisabled: boolean }> {
    const { workerId } = ArgsSchema.parse(args);
    const result = await this.useCase.execute({
      workerId,
      source: 'luz_conversation',
    });
    return { ok: result.ok, alreadyDisabled: result.alreadyDisabled };
  }
}
