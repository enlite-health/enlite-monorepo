/**
 * PatientCoverageEmergencyContactRepository — `patient_coverage_emergency_contacts` (migration 417; D301).
 *
 * Molde do `PatientResponsibleRepository`: escrita POR LINHA (spec 018, PR-1, ADR-1) —
 * `insertOne`/`updateOne`/`deactivate`, nunca `replaceAll` (achado do gate `revisao-pr`: este
 * comentário ainda descrevia o `replaceAll` DELETE+INSERT que o PR-1 aposentou). Telefone cifrado
 * via KMS antes de tocar o banco, decifrado na leitura só quando o chamador já decidiu que o ator
 * lê o container (D286 / lex P3: a célula decide ANTES de o KMS rodar — `fetchPatientDetail` só
 * chama `listForPatient` sob `reads.coverage`).
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
  PatientCoverageEmergencyContactPatch,
} from '../domain/PatientCoverageEmergencyContact';
import { deactivateRow, type DeactivateOutcome } from './deactivateRowByRow';

export interface CoverageEmergencyContactRow {
  id: string;
  kind: CoverageEmergencyContactKind;
  name: string;
  phone_encrypted: string;
  sort_order: number;
}

export type { DeactivateOutcome as CoverageContactDeactivateOutcome };

export class PatientCoverageEmergencyContactRepository {
  private readonly pool: Pool;
  private readonly enc: KMSEncryptionService;

  constructor(pool?: Pool, enc?: KMSEncryptionService) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.enc = enc ?? new KMSEncryptionService();
  }

  /**
   * Só o SELECT (ciphertext): roda junto das outras leituras da ficha, sem decifrar nada.
   * `active` sempre filtrado (FR-004, spec 018 PR-1) — a ficha só mostra linhas vivas.
   */
  async fetchRows(patientId: string, executor: Pool | PoolClient = this.pool): Promise<CoverageEmergencyContactRow[]> {
    const res = await executor.query<CoverageEmergencyContactRow>(
      `SELECT id, kind, name, phone_encrypted, sort_order
         FROM patient_coverage_emergency_contacts
        WHERE patient_id = $1 AND active
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
   * O `kind` ATUAL de uma linha — para o controller decidir o 403 de `patient_care_team:read`
   * ANTES de tocar em UPDATE/deactivate de uma linha que já é (ou vira) `DIRECT_PROFESSIONAL`
   * (lex C3: sem a célula da equipe, o ator nunca viu essa linha e não pode mexer nela).
   */
  async getKind(patientId: string, id: string, executor: Pool | PoolClient = this.pool): Promise<CoverageEmergencyContactKind | null> {
    const { rows } = await executor.query<{ kind: CoverageEmergencyContactKind }>(
      `SELECT kind FROM patient_coverage_emergency_contacts WHERE id = $2 AND patient_id = $1`,
      [patientId, id],
    );
    return rows[0]?.kind ?? null;
  }

  /**
   * `POST /patients/:id/coverage-emergency-contacts` (spec 018, PR-1, ADR-1) — escrita por LINHA.
   * O 403 de `DIRECT_PROFESSIONAL` sem `patient_care_team:read` é decidido no CONTROLLER (a
   * mesma regra do `keepKinds` de antes, agora antes do INSERT em vez de dentro do `replaceAll`).
   */
  async insertOne(
    patientId: string,
    input: PatientCoverageEmergencyContactInput,
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const phoneEnc = await this.enc.encrypt(input.phone.trim());
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, sort_order, created_by)
       VALUES ($1, $2, $3, $4,
         COALESCE((SELECT MAX(sort_order) + 1 FROM patient_coverage_emergency_contacts WHERE patient_id = $1), 0),
         $5)
       RETURNING id`,
      [patientId, input.kind, input.name.trim(), phoneEnc, actorUid],
    );
    return { id: rows[0].id };
  }

  /**
   * `PATCH /patients/:id/coverage-emergency-contacts/:cid` — UPDATE parcial de UMA linha (RFC
   * 7396). Devolve `null` quando a linha não existe ou é de outro paciente (404 no controller).
   */
  async updateOne(
    patientId: string,
    id: string,
    patch: PatientCoverageEmergencyContactPatch,
    client: PoolClient,
  ): Promise<{ id: string } | null> {
    const sets: string[] = [];
    const values: unknown[] = [patientId, id];
    const setColumn = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.kind !== undefined) setColumn('kind', patch.kind);
    if (patch.name !== undefined) setColumn('name', patch.name.trim());
    if (patch.phone !== undefined) setColumn('phone_encrypted', await this.enc.encrypt(patch.phone.trim()));

    if (sets.length === 0) {
      // PATCH vazio é no-op — MAS não é sucesso cego (achado do gate `revisao-pr`: um PATCH {} no
      // id de OUTRO paciente, ou numa linha já desativada, respondia 200 sem checar nada). Mesma
      // régua do UPDATE abaixo: só existe/pertence/está ativa → { id }; senão, null (404).
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM patient_coverage_emergency_contacts WHERE id = $2 AND patient_id = $1 AND active`,
        [patientId, id],
      );
      return rows[0] ? { id: rows[0].id } : null;
    }
    sets.push('updated_at = NOW()');

    // `AND active` (mesma régua de PatientResponsibleRepository.updateOne, task 1.10 alt 2):
    // editar uma linha já desativada por outra aba devolve 0 linhas ⇒ null ⇒ 404 no controller.
    const { rows } = await client.query<{ id: string }>(
      `UPDATE patient_coverage_emergency_contacts SET ${sets.join(', ')}
        WHERE id = $2 AND patient_id = $1 AND active
        RETURNING id`,
      values,
    );
    return rows[0] ? { id: rows[0].id } : null;
  }

  /**
   * `POST /patients/:id/coverage-emergency-contacts/:cid/deactivate` — nunca DELETE (FR-002).
   * `SELECT … FOR UPDATE` antes do `UPDATE`, mesmo molde do `PatientResponsibleRepository`, para
   * o controller distinguir 404 de 409 (já inativa).
   */
  async deactivate(
    patientId: string,
    id: string,
    actorUid: string,
    client: PoolClient,
  ): Promise<DeactivateOutcome> {
    return deactivateRow(client, 'patient_coverage_emergency_contacts', patientId, id, actorUid);
  }
}
