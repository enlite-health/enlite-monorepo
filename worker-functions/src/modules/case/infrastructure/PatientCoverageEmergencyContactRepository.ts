/**
 * PatientCoverageEmergencyContactRepository — `patient_coverage_emergency_contacts` (migration 417; D301).
 *
 * Molde do `PatientResponsibleRepository`: a tela edita a lista inteira → `replaceAll` (DELETE + INSERT
 * no MESMO client da transação da seção); telefone cifrado via KMS antes de tocar o banco, decifrado
 * na leitura só quando o chamador já decidiu que o ator lê o container (D286 / lex P3: a célula decide
 * ANTES de o KMS rodar — `fetchPatientDetail` só chama `listForPatient` sob `reads.coverage`).
 *
 * Não faz JOIN fora de `patients`. Nada aqui emite nome/telefone em log: contagem, sempre.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type {
  CoverageEmergencyContactKind,
  PatientCoverageEmergencyContactDetail,
  PatientCoverageEmergencyContactInput,
} from '../domain/PatientCoverageEmergencyContact';

export interface CoverageEmergencyContactRow {
  id: string;
  kind: CoverageEmergencyContactKind;
  name: string;
  phone_encrypted: string;
  sort_order: number;
}

export class PatientCoverageEmergencyContactRepository {
  private readonly pool: Pool;
  private readonly enc: KMSEncryptionService;

  constructor(pool?: Pool, enc?: KMSEncryptionService) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.enc = enc ?? new KMSEncryptionService();
  }

  /** Só o SELECT (ciphertext): roda junto das outras leituras da ficha, sem decifrar nada. */
  async fetchRows(patientId: string, executor: Pool | PoolClient = this.pool): Promise<CoverageEmergencyContactRow[]> {
    const res = await executor.query<CoverageEmergencyContactRow>(
      `SELECT id, kind, name, phone_encrypted, sort_order
         FROM patient_coverage_emergency_contacts
        WHERE patient_id = $1
        ORDER BY sort_order ASC, created_at ASC`,
      [patientId],
    );
    return res.rows;
  }

  /** A lista na ordem da tela, telefone decifrado. Chamar SÓ sob `patient_coverage:read`. */
  async listForPatient(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientCoverageEmergencyContactDetail[]> {
    return this.decryptRows(await this.fetchRows(patientId, executor));
  }

  /** Decifra o telefone de cada linha — o KMS só roda aqui (D286 / lex P3). */
  async decryptRows(rows: CoverageEmergencyContactRow[]): Promise<PatientCoverageEmergencyContactDetail[]> {
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        phone: (await this.enc.decrypt(r.phone_encrypted)) ?? '',
        sortOrder: r.sort_order,
      })),
    );
  }

  /**
   * Substitui a lista inteira do paciente (o caminho do drawer). Linha sem nome ou sem telefone é
   * descartada aqui — o zod já recusou antes; isto é a segunda trava, não a primeira.
   */
  async replaceAll(
    patientId: string,
    contacts: PatientCoverageEmergencyContactInput[],
    actorUid: string,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query('DELETE FROM patient_coverage_emergency_contacts WHERE patient_id = $1', [patientId]);
    const valid = contacts.filter((c) => c.name?.trim() && c.phone?.trim());
    if (valid.length === 0) return;

    const phones = await Promise.all(valid.map((c) => this.enc.encrypt(c.phone.trim())));
    const values: unknown[] = [];
    const placeholders = valid.map((c, i) => {
      const base = i * 6;
      values.push(patientId, c.kind, c.name.trim(), phones[i], i, actorUid);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    await executor.query(
      `INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, sort_order, created_by)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}
