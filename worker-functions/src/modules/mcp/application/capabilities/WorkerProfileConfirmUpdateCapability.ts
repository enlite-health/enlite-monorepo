/**
 * WorkerProfileConfirmUpdateCapability
 *
 * Fase 2 do propose/confirm da Luz. Recebe o handle do change estacionado e aplica
 * EXATAMENTE o que foi validado no propose — nenhum valor de campo é aceito aqui,
 * só o handle. O servidor detém a autoridade sobre o valor gravado.
 *
 * Esta é uma WRITE capability (rate-limited + audited no registry).
 */

import { z } from 'zod';
import type { ConfirmWorkerProfileUpdateUseCase } from '../../../worker/application/ConfirmWorkerProfileUpdateUseCase';
import { PROFILE_EDIT_SOURCES } from '../../../worker/domain/profileEditSource';

const ArgsSchema = z
  .object({
    workerId: z.string().uuid(),
    handle: z.string().uuid().optional(),
    conversationRef: z.string().max(120).optional(),
    /** Fonte da edição (rastreabilidade D92). Default: luz_conversation. */
    source: z.enum(PROFILE_EDIT_SOURCES).optional(),
  })
  .strict(); // no field values accepted here — only the handle

export type WorkerProfileConfirmUpdateArgs = z.infer<typeof ArgsSchema>;

export class WorkerProfileConfirmUpdateCapability {
  static readonly NAME = 'worker.profile.confirmUpdate';
  static readonly DESCRIPTION =
    'Confirm and apply a previously proposed worker profile update. Pass the handle from ' +
    'worker.profile.proposeUpdate. The server applies exactly the staged, validated value — ' +
    'no field values are accepted here. Call only AFTER the worker explicitly confirmed.';
  static readonly INPUT_SHAPE = {
    workerId: z.string().uuid(),
    handle: z.string().uuid().optional(),
    conversationRef: z.string().max(120).optional(),
    source: z.enum(PROFILE_EDIT_SOURCES).optional(),
  };

  constructor(private readonly useCase: ConfirmWorkerProfileUpdateUseCase) {}

  async execute(args: unknown): Promise<{
    applied: true;
    workerId: string;
    fieldsUpdated: string[];
  }> {
    const parsed = ArgsSchema.parse(args);
    return this.useCase.execute({
      workerId: parsed.workerId,
      handle: parsed.handle,
      conversationRef: parsed.conversationRef,
      source: parsed.source,
    });
  }
}
