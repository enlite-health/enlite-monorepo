/**
 * PatientEmergencyMarkRepository — `patients.emergency_responsible_id` /
 * `emergency_external_contact_id` (migration 423; spec 018, PR-2, D-A, SUP-39).
 *
 * A marca aponta para UMA linha já existente em `patient_responsibles` OU `patient_external_contacts`
 * — nunca as duas (`CHECK num_nonnulls`, D-A #1). Este repositório não cria titular nem categoria
 * de dado nova: só referencia. A validade (ativo + telefone) é checada aqui ANTES do UPDATE, para
 * o controller responder 404 (linha não é do paciente / inativa) distinto de 422 (sem telefone) —
 * o trigger da 423 (`fn_patients_emergency_mark_valida`) é a defesa de segunda linha no banco.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export type EmergencyMarkKind = 'RESPONSIBLE' | 'EXTERNAL';
export type EmergencyMarkTarget = { kind: EmergencyMarkKind; id: string } | null;

const TABLE_OF: Record<EmergencyMarkKind, 'patient_responsibles' | 'patient_external_contacts'> = {
  RESPONSIBLE: 'patient_responsibles',
  EXTERNAL: 'patient_external_contacts',
};
const COLUMN_OF: Record<EmergencyMarkKind, 'emergency_responsible_id' | 'emergency_external_contact_id'> = {
  RESPONSIBLE: 'emergency_responsible_id',
  EXTERNAL: 'emergency_external_contact_id',
};

export type MarkOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'requires_phone' }
  | { outcome: 'marked' };

export class PatientEmergencyMarkRepository {
  private readonly pool: Pool;
  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  /** `emergencyContactRef` para a ficha — projetado SOB `patient_family:read` (D286). */
  async getRef(patientId: string, executor: Pool | PoolClient = this.pool): Promise<EmergencyMarkTarget> {
    const { rows } = await executor.query<{ emergency_responsible_id: string | null; emergency_external_contact_id: string | null }>(
      `SELECT emergency_responsible_id, emergency_external_contact_id FROM patients WHERE id = $1`,
      [patientId],
    );
    const p = rows[0];
    if (!p) return null;
    if (p.emergency_responsible_id) return { kind: 'RESPONSIBLE', id: p.emergency_responsible_id };
    if (p.emergency_external_contact_id) return { kind: 'EXTERNAL', id: p.emergency_external_contact_id };
    return null;
  }

  /**
   * `PUT /patients/:id/emergency-contact` — troca a marca (limpa a coluna do OUTRO conjunto no
   * mesmo UPDATE, já que `num_nonnulls <= 1` exige que só uma esteja preenchida).
   */
  async mark(patientId: string, kind: EmergencyMarkKind, contactId: string, client: PoolClient): Promise<MarkOutcome> {
    const table = TABLE_OF[kind];
    const { rows } = await client.query<{ active: boolean; has_phone: boolean }>(
      `SELECT active, (phone_encrypted IS NOT NULL) AS has_phone FROM ${table} WHERE id = $2 AND patient_id = $1`,
      [patientId, contactId],
    );
    const row = rows[0];
    if (!row || !row.active) return { outcome: 'not_found' };
    if (!row.has_phone) return { outcome: 'requires_phone' };

    const setColumn = COLUMN_OF[kind];
    const clearColumn = kind === 'RESPONSIBLE' ? COLUMN_OF.EXTERNAL : COLUMN_OF.RESPONSIBLE;
    await client.query(
      `UPDATE patients SET ${setColumn} = $2, ${clearColumn} = NULL WHERE id = $1`,
      [patientId, contactId],
    );
    return { outcome: 'marked' };
  }

  /** `DELETE /patients/:id/emergency-contact` — limpa as duas colunas (no máximo 1 estava preenchida). */
  async unmark(patientId: string, client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE patients SET emergency_responsible_id = NULL, emergency_external_contact_id = NULL WHERE id = $1`,
      [patientId],
    );
  }
}
