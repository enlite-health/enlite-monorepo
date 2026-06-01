/**
 * ProposeWorkerProfileUpdateUseCase
 *
 * Fase 1 do fluxo propose/confirm da Luz. Recebe os campos JÁ VALIDADOS pela
 * capability (Zod, Latam-aware, sem email/phone), NÃO grava no perfil — apenas
 * estaciona o change criptografado (KMS) na tabela de pending e devolve:
 *   - handle: id opaco da linha estacionada (devolvido no confirm)
 *   - summary: campos + valores novos pra Luz mostrar "vou atualizar X para Y, confirma?"
 *
 * O valor fica no servidor; a Luz não consegue trocá-lo entre propor e confirmar.
 */

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PendingProfileChangeRepository } from '../infrastructure/PendingProfileChangeRepository';

/** TTL do staging: o worker precisa confirmar dentro dessa janela. */
export const PENDING_CHANGE_TTL_SECONDS = 5 * 60;

export interface LuzProfileAddress {
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  zipCode?: string;
  state?: string;
}

/** Campos que a Luz pode propor na v1 (sem email/phone — esses são handover). */
export interface LuzProfileFields {
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  documentType?: string;
  documentNumber?: string;
  address?: LuzProfileAddress;
}

export interface ProposeSummaryItem {
  field: string;
  newValue: string;
}

export interface ProposeProfileUpdateResult {
  handle: string;
  expiresAt: string;
  summary: ProposeSummaryItem[];
}

export class NoFieldsToUpdateError extends Error {
  readonly code = 'NO_FIELDS_TO_UPDATE';
  constructor() {
    super('At least one field must be provided');
    this.name = 'NoFieldsToUpdateError';
  }
}

export class ProposeWorkerProfileUpdateUseCase {
  constructor(
    private readonly pending: PendingProfileChangeRepository,
    private readonly encryption: KMSEncryptionService,
  ) {}

  async execute(input: {
    workerId: string;
    fields: LuzProfileFields;
    conversationRef?: string;
  }): Promise<ProposeProfileUpdateResult> {
    const summary = buildSummary(input.fields);
    if (summary.length === 0) {
      throw new NoFieldsToUpdateError();
    }

    const payloadEncrypted = await this.encryption.encrypt(
      JSON.stringify(input.fields),
    );
    if (payloadEncrypted == null) {
      throw new Error('Failed to encrypt pending profile change payload');
    }

    const { id, expiresAt } = await this.pending.insert({
      workerId: input.workerId,
      conversationRef: input.conversationRef ?? null,
      payloadEncrypted,
      fieldNames: summary.map((s) => s.field),
      ttlSeconds: PENDING_CHANGE_TTL_SECONDS,
    });

    return { handle: id, expiresAt: expiresAt.toISOString(), summary };
  }
}

/**
 * Achata os campos em pares {field, newValue} pra Luz confirmar com o worker.
 * Valores ficam em claro de propósito: é o dado do próprio worker, que ele acabou
 * de informar pelo mesmo canal — ele precisa ver o que será gravado.
 */
function buildSummary(fields: LuzProfileFields): ProposeSummaryItem[] {
  const items: ProposeSummaryItem[] = [];
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
      items.push({ field: key, newValue: v });
    }
  }
  if (fields.address) {
    for (const [k, v] of Object.entries(fields.address)) {
      if (typeof v === 'string' && v.length > 0) {
        items.push({ field: `address.${k}`, newValue: v });
      }
    }
  }
  return items;
}
