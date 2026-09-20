/**
 * PatientExternalContactRepository — `patient_external_contacts` (migration 422; spec 018, PR-2).
 *
 * Molde do `PatientCoverageEmergencyContactRepository`: escrita POR LINHA (ADR-1) —
 * `insertOne`/`updateOne`/`deactivate`, nunca `replaceAll`/DELETE. Telefone cifrado via KMS antes
 * de tocar o banco (opcional — sem telefone não pode ser marcado de emergência, D-A #3),
 * decifrado na leitura só quando o chamador já decidiu que o ator lê `patient_family` (D286 / lex
 * P3, mesma régua de `PatientResponsibleRepository`).
 *
 * Não faz JOIN fora de `patients`. Nada aqui emite nome/telefone em log: ids, sempre.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  type ExternalContactRelation,
  type PatientExternalContactDetail,
  type PatientExternalContactInput,
  type PatientExternalContactPatch,
} from '../domain/PatientExternalContact';
import { deactivateRow, type DeactivateOutcome } from './deactivateRowByRow';
import { EmergencyContactRequiresPhoneError, isEmergencyMarkCheckViolation } from './EmergencyContactRequiresPhoneError';

export interface ExternalContactRow {
  id: string;
  relation: ExternalContactRelation;
  name: string;
  phone_encrypted: string | null;
  sort_order: number;
}

export type { DeactivateOutcome as ExternalContactDeactivateOutcome };

export class PatientExternalContactRepository {
  private readonly pool: Pool;
  private readonly enc: KMSEncryptionService;

  constructor(pool?: Pool, enc?: KMSEncryptionService) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.enc = enc ?? new KMSEncryptionService();
  }

  /** Só o SELECT (ciphertext) — `active` sempre filtrado (mesma régua dos responsáveis). */
  async fetchRows(patientId: string, executor: Pool | PoolClient = this.pool): Promise<ExternalContactRow[]> {
    const res = await executor.query<ExternalContactRow>(
      `SELECT id, relation, name, phone_encrypted, sort_order
         FROM patient_external_contacts
        WHERE patient_id = $1 AND active
        ORDER BY sort_order ASC, created_at ASC`,
      [patientId],
    );
    return res.rows;
  }

  /** A lista na ordem da tela, telefone decifrado. Chamar SÓ sob `patient_family:read`. */
  async listForPatient(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientExternalContactDetail[]> {
    return this.decryptRows(await this.fetchRows(patientId, executor));
  }

  /** Decifra o telefone de cada linha — o KMS só roda aqui (D286 / lex P3). */
  async decryptRows(rows: ExternalContactRow[]): Promise<PatientExternalContactDetail[]> {
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        relation: r.relation,
        name: r.name,
        phone: r.phone_encrypted ? await this.enc.decrypt(r.phone_encrypted) : null,
        active: true as const,
      })),
    );
  }

  /** `POST /patients/:id/external-contacts` (spec 018, PR-2, ADR-1) — escrita por LINHA, id novo. */
  async insertOne(
    patientId: string,
    input: PatientExternalContactInput,
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const phoneEnc = input.phone ? await this.enc.encrypt(input.phone.trim()) : null;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, sort_order, created_by)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM patient_external_contacts WHERE patient_id = $1),
         $5)
       RETURNING id`,
      [patientId, input.relation, input.name.trim(), phoneEnc, actorUid],
    );
    return { id: rows[0].id };
  }

  /**
   * `PATCH /patients/:id/external-contacts/:xid` — UPDATE parcial de UMA linha (RFC 7396).
   * Devolve `null` quando a linha não existe/é de outro paciente/está desativada (404 no
   * controller). 422 `EmergencyContactRequiresPhoneError` quando o PATCH apaga o telefone de uma
   * linha que está marcada de emergência (trigger da migration 423, D-A #4/SUP-40).
   */
  async updateOne(
    patientId: string,
    id: string,
    patch: PatientExternalContactPatch,
    client: PoolClient,
  ): Promise<{ id: string } | null> {
    const sets: string[] = [];
    const values: unknown[] = [patientId, id];
    const setColumn = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.relation !== undefined) setColumn('relation', patch.relation);
    if (patch.name !== undefined) setColumn('name', patch.name.trim());
    if (Object.prototype.hasOwnProperty.call(patch, 'phone')) {
      setColumn('phone_encrypted', patch.phone ? await this.enc.encrypt(patch.phone.trim()) : null);
    }

    if (sets.length === 0) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM patient_external_contacts WHERE id = $2 AND patient_id = $1 AND active`,
        [patientId, id],
      );
      return rows[0] ? { id: rows[0].id } : null;
    }
    sets.push('updated_at = NOW()');

    try {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE patient_external_contacts SET ${sets.join(', ')}
          WHERE id = $2 AND patient_id = $1 AND active
          RETURNING id`,
        values,
      );
      return rows[0] ? { id: rows[0].id } : null;
    } catch (err: unknown) {
      if (isEmergencyMarkCheckViolation(err)) throw new EmergencyContactRequiresPhoneError();
      throw err;
    }
  }

  /** `POST /patients/:id/external-contacts/:xid/deactivate` — nunca DELETE. */
  async deactivate(
    patientId: string,
    id: string,
    actorUid: string,
    client: PoolClient,
  ): Promise<DeactivateOutcome> {
    return deactivateRow(client, 'patient_external_contacts', patientId, id, actorUid);
  }
}
