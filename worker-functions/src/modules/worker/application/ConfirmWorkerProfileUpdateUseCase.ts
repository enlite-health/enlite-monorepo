/**
 * ConfirmWorkerProfileUpdateUseCase
 *
 * Fase 2 do fluxo propose/confirm da Luz. Carrega o change estacionado, faz o
 * claim atômico (idempotência), descriptografa o payload e aplica EXATAMENTE o
 * que foi validado no propose — a Luz não passa valor aqui, só o handle. Depois
 * grava o audit (de→para redigido).
 */

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { logger } from '@shared/logging';
import { PendingProfileChangeRepository } from '../infrastructure/PendingProfileChangeRepository';
import {
  ProfileChangeAuditRepository,
  ProfileChangeAuditEntry,
} from '../infrastructure/ProfileChangeAuditRepository';
import { UpdateWorkerProfileFieldsUseCase } from './UpdateWorkerProfileFieldsUseCase';
import { LuzProfileFields } from './ProposeWorkerProfileUpdateUseCase';
import { redactProfileValue } from './profileChangeRedaction';

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
    private readonly audit: ProfileChangeAuditRepository,
    private readonly encryption: KMSEncryptionService,
    private readonly updateUseCase: UpdateWorkerProfileFieldsUseCase,
  ) {}

  async execute(input: {
    workerId: string;
    handle?: string;
    conversationRef?: string;
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

    const result = await this.updateUseCase.execute({
      workerId: input.workerId,
      ...fields,
    });

    await this.audit.recordBatch(
      buildAuditEntries(record.id, input, fields, record.conversationRef),
    );

    logger
      .child({ workerId: input.workerId, useCase: 'ConfirmWorkerProfileUpdateUseCase' })
      .info({ msg: 'profile change confirmed via Luz', fieldsUpdated: result.fieldsUpdated });

    return { applied: true, workerId: result.workerId, fieldsUpdated: result.fieldsUpdated };
  }
}

function buildAuditEntries(
  pendingChangeId: string,
  input: { workerId: string; conversationRef?: string },
  fields: LuzProfileFields,
  recordConversationRef: string | null,
): ProfileChangeAuditEntry[] {
  const conversationRef = input.conversationRef ?? recordConversationRef;
  const entries: ProfileChangeAuditEntry[] = [];

  const scalarKeys: (keyof LuzProfileFields)[] = [
    'firstName',
    'lastName',
    'birthDate',
    'documentType',
    'documentNumber',
  ];
  for (const key of scalarKeys) {
    const v = fields[key];
    if (typeof v === 'string' && v.length > 0) {
      entries.push(makeEntry(pendingChangeId, input.workerId, key, v, conversationRef));
    }
  }
  if (fields.address) {
    for (const [k, v] of Object.entries(fields.address)) {
      if (typeof v === 'string' && v.length > 0) {
        entries.push(
          makeEntry(pendingChangeId, input.workerId, `address.${k}`, v, conversationRef),
        );
      }
    }
  }
  return entries;
}

function makeEntry(
  pendingChangeId: string,
  workerId: string,
  field: string,
  newValue: string,
  conversationRef: string | null,
): ProfileChangeAuditEntry {
  return {
    workerId,
    pendingChangeId,
    fieldName: field,
    oldValueRedacted: null, // coluna de origem é criptografada; old não é lido na v1
    newValueRedacted: redactProfileValue(field, newValue),
    changedBy: 'luz',
    source: 'triage',
    conversationRef,
  };
}
