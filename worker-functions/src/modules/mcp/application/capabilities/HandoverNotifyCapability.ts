import { z } from 'zod';
import type {
  NotifyHandoverUseCase,
  NotifyHandoverResult,
} from '../../../notification/application/NotifyHandoverUseCase';

const ArgsShape = {
  workerPhone: z.string().min(8),
  workerName: z.string().max(120).optional(),
  team: z.enum(['recruitment', 'community_manager']),
  reason: z.string().min(1).max(500),
  conversationId: z.number().int().positive(),
};

const ArgsSchema = z.object(ArgsShape);

/**
 * HandoverNotifyCapability (handover.notify) — WRITE.
 *
 * A Luz acabou de fazer handover no Chatwoot e avisa o TIME onde ele trabalha
 * (Periskope): mensagem no grupo do team + ticket best-effort no 1-1. Nada é
 * enviado ao candidato. Best-effort de ponta a ponta (o use case nunca lança);
 * kill-switch `HANDOVER_NOTIFY_ENABLED` devolve `{skipped:true}` sem efeito.
 */
export class HandoverNotifyCapability {
  static readonly NAME = 'handover.notify';
  static readonly DESCRIPTION =
    'Notify the human team on Periskope (team group message + best-effort ticket) that Luz handed a conversation over. Internal notification only — nothing is sent to the candidate.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: NotifyHandoverUseCase) {}

  async execute(args: unknown): Promise<NotifyHandoverResult> {
    const input = ArgsSchema.parse(args);
    return this.useCase.execute(input);
  }
}
