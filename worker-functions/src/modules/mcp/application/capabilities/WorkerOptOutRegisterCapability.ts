import { z } from 'zod';
import type { RegisterOptOutUseCase } from '../../../notification/application/RegisterOptOutUseCase';

const ArgsShape = {
  workerId: z.string().uuid(),
  reason: z.string().optional(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * WorkerOptOutRegisterCapability (worker.optOut.register) — WRITE.
 *
 * A Luz registra a baixa (opt-out) quando o worker pede parar de receber
 * mensagens NA CONVERSA. Delega para o RegisterOptOutUseCase — a MESMA fonte
 * de escrita dos webhooks (nada de query duplicada aqui). Idempotente
 * (re-opt-out via ON CONFLICT). `source` fixo = 'luz_conversation' pra o
 * audit distinguir baixa vinda da IA das vindas por webhook.
 */
export class WorkerOptOutRegisterCapability {
  static readonly NAME = 'worker.optOut.register';
  static readonly DESCRIPTION =
    'Register a messaging opt-out (baja) for a worker who asked, in conversation, to stop receiving messages. Idempotent.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: RegisterOptOutUseCase) {}

  async execute(args: unknown): Promise<{ ok: boolean }> {
    const { workerId, reason } = ArgsSchema.parse(args);
    const result = await this.useCase.execute({
      workerId,
      reason: reason ?? 'user_request',
      source: 'luz_conversation',
    });
    return { ok: result.ok };
  }
}
