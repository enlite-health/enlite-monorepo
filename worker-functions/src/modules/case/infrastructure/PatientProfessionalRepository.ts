/**
 * PatientProfessionalRepository — `patient_professionals` (migrations 038/068/071/420/427; spec
 * 018, PR-5, US-11; `lex` 12/09 CONDICIONADO).
 *
 * Molde do `PatientCoverageEmergencyContactRepository`: escrita POR LINHA (`insertOne`/`updateOne`/
 * `deactivate`) para a linha do PAINEL — nunca `replaceAll` (isso é do sync do ClickUp,
 * `replacePatientProfessionals`, que já filtra `source='clickup'`). Telefone/e-mail cifrados via
 * KMS antes de tocar o banco; decifrados na leitura só quando o chamador já decidiu que o ator lê
 * o container (`patient_care_team:read` — D286/lex P3, decisão em `fetchPatientDetail`).
 *
 * Nada aqui emite nome/telefone/e-mail/especialidade em log: contagem e ids, sempre (lex C10).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type {
  PatientProfessionalDetail,
  PatientProfessionalInput,
  PatientProfessionalPatch,
} from '../domain/PatientProfessional';
import { deactivateRow, type DeactivateOutcome } from './deactivateRowByRow';

export interface PatientProfessionalRow {
  id: string;
  name: string;
  phone_encrypted: string | null;
  email_encrypted: string | null;
  specialty: string | null;
  display_order: number;
  is_team: boolean;
}

export type { DeactivateOutcome as ProfessionalDeactivateOutcome };

export class PatientProfessionalRepository {
  private readonly pool: Pool;
  private readonly enc: KMSEncryptionService;

  constructor(pool?: Pool, enc?: KMSEncryptionService) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.enc = enc ?? new KMSEncryptionService();
  }

  /** Só o SELECT (ciphertext) — `active` sempre filtrado (a ficha só mostra linhas vivas). */
  async fetchRows(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientProfessionalRow[]> {
    const res = await executor.query<PatientProfessionalRow>(
      `SELECT id, name, phone_encrypted, email_encrypted, specialty, display_order, is_team
         FROM patient_professionals
        WHERE patient_id = $1 AND active
        ORDER BY display_order ASC, created_at ASC`,
      [patientId],
    );
    return res.rows;
  }

  /** A lista na ordem da tela, telefone/e-mail decifrados. Chamar SÓ sob `patient_care_team:read`
   * (lex C2/P3 — o KMS não roda se o chamador não tiver decidido isso ANTES). */
  async listForPatient(patientId: string, executor: Pool | PoolClient = this.pool): Promise<PatientProfessionalDetail[]> {
    return this.decryptRows(await this.fetchRows(patientId, executor));
  }

  /** Decifra telefone/e-mail de cada linha — o KMS só roda aqui. */
  async decryptRows(rows: PatientProfessionalRow[]): Promise<PatientProfessionalDetail[]> {
    return Promise.all(
      rows.map(async (r) => {
        const [phone, email] = await Promise.all([
          this.enc.decrypt(r.phone_encrypted),
          this.enc.decrypt(r.email_encrypted),
        ]);
        return {
          id: r.id,
          name: r.name,
          phone: phone ?? null,
          email: email ?? null,
          specialty: (r.specialty as PatientProfessionalDetail['specialty']) ?? null,
          displayOrder: r.display_order,
          isTeam: r.is_team,
        };
      }),
    );
  }

  /**
   * `POST /patients/:id/professionals` (spec 018, PR-5) — escrita por LINHA, sempre
   * `source='admin_manual'` (premissa 1 desta execução: `created_by` obrigatório para esta
   * origem — CHECK `pp_created_by_obrigatorio_admin_manual` na migration 427 é a régua de fundo;
   * o `actorUid` aqui nunca é opcional, mesma defesa de `AdminPatientContactRowsController.actorUid`).
   */
  async insertOne(
    patientId: string,
    input: PatientProfessionalInput,
    actorUid: string,
    client: PoolClient,
  ): Promise<{ id: string }> {
    const [phoneEnc, emailEnc] = await Promise.all([
      this.enc.encrypt(input.phone?.trim() || null),
      this.enc.encrypt(input.email?.trim() || null),
    ]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_professionals
         (patient_id, name, phone_encrypted, email_encrypted, specialty, display_order, source, created_by, is_team)
       VALUES ($1, $2, $3, $4, $5,
         (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_professionals WHERE patient_id = $1),
         'admin_manual', $6, false)
       RETURNING id`,
      [patientId, input.name.trim(), phoneEnc, emailEnc, input.specialty, actorUid],
    );
    return { id: rows[0].id };
  }

  /**
   * `PATCH /patients/:id/professionals/:pid` — UPDATE parcial de UMA linha (RFC 7396). `AND
   * active` (mesmo molde dos responsáveis/cobertura): editar linha já desativada por outra aba
   * devolve 0 linhas ⇒ `null` ⇒ 404 no controller. Devolve `null` também quando a linha é de OUTRO
   * paciente ou não existe.
   */
  async updateOne(
    patientId: string,
    id: string,
    patch: PatientProfessionalPatch,
    client: PoolClient,
  ): Promise<{ id: string } | null> {
    const sets: string[] = [];
    const values: unknown[] = [patientId, id];
    const setColumn = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.name !== undefined) setColumn('name', patch.name.trim());
    if (patch.phone !== undefined) setColumn('phone_encrypted', await this.enc.encrypt(patch.phone?.trim() || null));
    if (patch.email !== undefined) setColumn('email_encrypted', await this.enc.encrypt(patch.email?.trim() || null));
    if (patch.specialty !== undefined) setColumn('specialty', patch.specialty);

    if (sets.length === 0) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM patient_professionals WHERE id = $2 AND patient_id = $1 AND active`,
        [patientId, id],
      );
      return rows[0] ? { id: rows[0].id } : null;
    }
    sets.push('updated_at = NOW()');

    const { rows } = await client.query<{ id: string }>(
      `UPDATE patient_professionals SET ${sets.join(', ')}
        WHERE id = $2 AND patient_id = $1 AND active
        RETURNING id`,
      values,
    );
    return rows[0] ? { id: rows[0].id } : null;
  }

  /** `POST /patients/:id/professionals/:pid/deactivate` — nunca DELETE (C8). */
  async deactivate(
    patientId: string,
    id: string,
    actorUid: string,
    client: PoolClient,
  ): Promise<DeactivateOutcome> {
    return deactivateRow(client, 'patient_professionals', patientId, id, actorUid);
  }
}
