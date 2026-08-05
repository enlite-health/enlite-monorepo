/**
 * ConfirmWorkerProfileUpdateUseCase
 *
 * Fase 2 do fluxo propose/confirm da Luz. Carrega o change estacionado, faz o
 * claim atômico (idempotência), descriptografa o payload e aplica EXATAMENTE o
 * que foi validado no propose — a Luz não passa valor aqui, só o handle.
 *
 * A trilha de fonte (worker_profile_changes_audit, de→para redigido) é gravada
 * pelo UpdateWorkerProfileFieldsUseCase na MESMA transação da escrita, com
 * changed_by='luz_conversation' (enum de profileEditSource).
 */

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { logger } from '@shared/logging';
import { PendingProfileChangeRepository } from '../infrastructure/PendingProfileChangeRepository';
import { UpdateWorkerProfileFieldsUseCase } from './UpdateWorkerProfileFieldsUseCase';
import { LuzProfileFields } from './ProposeWorkerProfileUpdateUseCase';
import type { ProfileEditSource } from '../domain/profileEditSource';

export interface ConfirmProfileUpdateResult {
  applied: true;
  workerId: string;
  fieldsUpdated: string[];
}

export class PendingChangeNotFoundError extends Error {
  readonly code = 'PENDING_CHANGE_NOT_FOUND';
  constructor(workerId: string, handle?: string) {
    super(
      `No active pending profile change for worker ${workerId}` +
        (handle ? ` with handle ${handle}` : ''),
    );
    this.name = 'PendingChangeNotFoundError';
  }
}

export class ConfirmWorkerProfileUpdateUseCase {
  constructor(
    private readonly pending: PendingProfileChangeRepository,
    private readonly encryption: KMSEncryptionService,
    private readonly updateUseCase: UpdateWorkerProfileFieldsUseCase,
  ) {}

  async execute(input: {
    workerId: string;
    handle?: string;
    conversationRef?: string;
    /** Fonte explícita do chamador (task 2.2); default = Luz na conversa. */
    source?: ProfileEditSource;
  }): Promise<ConfirmProfileUpdateResult> {
    const record = await this.pending.findActive(input.workerId, input.handle);
    if (!record) {
      throw new PendingChangeNotFoundError(input.workerId, input.handle);
    }

    // Claim antes de aplicar: garante que um confirm duplicado/concorrente não
    // aplique duas vezes. Se já foi consumida, trata como não encontrada.
    const claimed = await this.pending.markConsumed(record.id);
    if (!claimed) {
      throw new PendingChangeNotFoundError(input.workerId, input.handle);
    }

    const json = await this.encryption.decrypt(record.payloadEncrypted);
    const fields = JSON.parse(json) as LuzProfileFields;

    const result = await this.updateUseCase.execute(
      {
        workerId: input.workerId,
        ...fields,
      },
      {
        source: input.source ?? 'luz_conversation',
        actorUid: 'luz:profile-confirm',
        conversationRef: input.conversationRef ?? record.conversationRef,
        pendingChangeId: record.id,
      },
    );

    logger
      .child({ workerId: input.workerId, useCase: 'ConfirmWorkerProfileUpdateUseCase' })
      .info({ msg: 'profile change confirmed via Luz', fieldsUpdated: result.fieldsUpdated });

    return { applied: true, workerId: result.workerId, fieldsUpdated: result.fieldsUpdated };
  }
}
