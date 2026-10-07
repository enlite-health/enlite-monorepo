/**
 * PatientAddressAuditRepository — trilha da REMOÇÃO de Localización (spec 044, migration 501).
 *
 * Casca fina sobre `BaseAuditLogRepository` (composição, molde `AiPromptAuditRepository`) para
 * `patient_address_audit_log` com FK `patient_id`.
 *
 * ⚠️ Expõe SÓ `logDeleted`, sobre `logEvent` (NÃO `logEventSafe`): aqui a trilha É a condição do DELETE.
 * Se o INSERT da auditoria falha, a exceção sobe, a transação (a MESMA do DELETE, mesmo client) faz
 * ROLLBACK e o endereço continua lá. NÃO acrescentar wrapper para `logEventSafe`.
 *
 * ⚠️ PII: `changes` é montado por lista POSITIVA de chaves (`buildAddressDeletedChanges`) — só
 * `address_id`, `address_type` e `neighborhood`. Nunca `address_formatted`/`address_raw`/`complement`/
 * `access_notes`/`lat`/`lng`: o objetivo do DELETE físico é minimização, e a regra dura é nunca logar PII.
 * Coluna nova em `patient_addresses` jamais entra aqui por omissão.
 */
import type { PoolClient } from 'pg';
import { BaseAuditLogRepository } from '@shared/audit/BaseAuditLogRepository';
import type { AuditChangesPayload } from '@shared/audit/types';

const BASE = new BaseAuditLogRepository({
  tableName: 'patient_address_audit_log',
  entityColumn: 'patient_id',
});

/** O que da linha apagada pode entrar na trilha. Lista POSITIVA: nenhum texto de endereço. */
export interface AddressDeletedSnapshot {
  address_id: string;
  address_type: string | null;
  neighborhood: string | null;
}

/**
 * Monta `{ before: { address_id, address_type, neighborhood }, after: null }` a partir de QUALQUER linha:
 * copia só as 3 chaves nomeadas, ignorando o resto (inclusive o texto do endereço, se a linha o trouxer).
 */
export function buildAddressDeletedChanges(row: { id: string; address_type?: string | null; neighborhood?: string | null }): AuditChangesPayload {
  const before: AddressDeletedSnapshot = {
    address_id: row.id,
    address_type: row.address_type ?? null,
    neighborhood: row.neighborhood ?? null,
  };
  return { before, after: null };
}

export interface LogAddressDeletedParams {
  patientId: string;
  changes: AuditChangesPayload;
  /** firebase_uid de quem removeu. */
  actorUserId: string | null;
  traceId?: string | null;
}

export class PatientAddressAuditRepository {
  /** Grava o evento DELETED na transação do caller (a que apaga a linha). Propaga a exceção do INSERT. */
  async logDeleted(client: PoolClient, params: LogAddressDeletedParams): Promise<void> {
    return BASE.logEvent(client, {
      entityId: params.patientId,
      eventType: 'DELETED',
      fieldName: null,
      changes: params.changes,
      actorUserId: params.actorUserId,
      actorType: 'HUMAN',
      traceId: params.traceId ?? null,
    });
  }
}
