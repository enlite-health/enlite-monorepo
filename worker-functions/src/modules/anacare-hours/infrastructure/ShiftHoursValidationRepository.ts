/**
 * src/modules/anacare-hours/infrastructure/ShiftHoursValidationRepository.ts
 *
 * Acesso a `shift_hours_validation` (migration 437) — o OK da operadora, chaveado por
 * `(source, source_shift_id)`. Sem linha = turno ainda PENDENTE (estado virtual: não precisamos
 * de uma linha `pendente` para cada turno sintético — só gravamos quando algo muda, spec
 * §Retrato de turnos separado da validação).
 */

import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { ContestReason } from '../domain/AnaCareShift';

export interface ValidationRow {
  sourceShiftId: string;
  status: 'pendente' | 'validado' | 'contestado';
  approvedHours: number | null;
  approvedCheckinAt: string | null;
  approvedCheckoutAt: string | null;
  approvedCheckinSource: 'app' | 'web_admin' | null;
  validatedBy: string | null;
  validatedByName: string | null;
  validatedAt: string | null;
  reason: ContestReason | null;
  noteEncrypted: string | null;
}

interface ValidationRowSql {
  source_shift_id: string;
  status: 'pendente' | 'validado' | 'contestado';
  approved_hours: string | null;
  approved_checkin_at: string | null;
  approved_checkout_at: string | null;
  approved_checkin_source: 'app' | 'web_admin' | null;
  validated_by: string | null;
  validated_by_name: string | null;
  validated_at: string | null;
  reason: ContestReason | null;
  note_encrypted: string | null;
}

const SOURCE = 'anacare';

const toRow = (r: ValidationRowSql): ValidationRow => ({
  sourceShiftId: r.source_shift_id,
  status: r.status,
  approvedHours: r.approved_hours === null ? null : Number(r.approved_hours),
  approvedCheckinAt: r.approved_checkin_at,
  approvedCheckoutAt: r.approved_checkout_at,
  approvedCheckinSource: r.approved_checkin_source,
  validatedBy: r.validated_by,
  validatedByName: r.validated_by_name,
  validatedAt: r.validated_at,
  reason: r.reason,
  noteEncrypted: r.note_encrypted,
});

/** Já validado (não pode virar contestado nem validar de novo). */
export class ShiftAlreadyValidatedError extends Error {
  readonly code = 'JA_VALIDADO';
  constructor() {
    super('JA_VALIDADO');
  }
}

export class ShiftHoursValidationRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Busca em lote por `source_shift_id` — 1 query para N turnos (evita N+1 no snapshot do mês). */
  async getByShiftIds(sourceShiftIds: readonly string[]): Promise<Map<string, ValidationRow>> {
    if (sourceShiftIds.length === 0) return new Map();
    const res = await this.pool.query<ValidationRowSql>(
      `SELECT v.source_shift_id, v.status, v.approved_hours, v.approved_checkin_at, v.approved_checkout_at,
              v.approved_checkin_source, v.validated_by, u.display_name AS validated_by_name, v.validated_at,
              v.reason, v.note_encrypted
         FROM shift_hours_validation v
         LEFT JOIN users u ON u.firebase_uid = v.validated_by
        WHERE v.source = $1 AND v.source_shift_id = ANY($2::text[])`,
      [SOURCE, sourceShiftIds as string[]],
    );
    const out = new Map<string, ValidationRow>();
    for (const row of res.rows) out.set(row.source_shift_id, toRow(row));
    return out;
  }

  async getOne(sourceShiftId: string): Promise<ValidationRow | null> {
    const map = await this.getByShiftIds([sourceShiftId]);
    return map.get(sourceShiftId) ?? null;
  }

  /**
   * F6.2 (D361, fase-6.md "A contagem de validados, que perde o join"): a contagem por paciente
   * deixa de nascer do join 1:1 `anacare_shift` × `shift_hours_validation` por `source_shift_id`
   * (turno não existe mais no nosso banco) e passa a vir direto daqui — `GROUP BY (paciente,
   * status)` sobre o mês inteiro, 1 query para todos os pacientes (nunca 1 por paciente, mesmo
   * padrão de `getByShiftIds`). `periodMonth` no formato `YYYY-MM-DD` (1º dia do mês), mesma
   * convenção de `validate`/`contest`.
   */
  async getStatusCountsByMonth(periodMonth: string): Promise<Map<string, { validated: number; contested: number }>> {
    const res = await this.pool.query<{ ana_care_patient_id: string; status: ValidationRow['status']; count: string }>(
      `SELECT ana_care_patient_id, status, COUNT(*) AS count
         FROM shift_hours_validation
        WHERE source = $1 AND period_month = $2
        GROUP BY 1, 2`,
      [SOURCE, periodMonth],
    );
    const out = new Map<string, { validated: number; contested: number }>();
    for (const row of res.rows) {
      const entry = out.get(row.ana_care_patient_id) ?? { validated: 0, contested: 0 };
      if (row.status === 'validado') entry.validated = Number(row.count);
      else if (row.status === 'contestado') entry.contested = Number(row.count);
      out.set(row.ana_care_patient_id, entry);
    }
    return out;
  }

  /**
   * Grava o OK: pendente/inexistente/contestado → validado. `validado → validado` (dupla
   * validação, inclusive dupla chamada da mesma pessoa) é recusado ANTES do UPDATE — o próprio
   * trigger de imutabilidade (437) bloquearia a mesma coisa, mas aqui vira erro de negócio
   * (409), não erro de banco.
   */
  async validate(input: {
    sourceShiftId: string;
    anaCarePatientId: string;
    anaCareNurseId: string;
    periodMonth: string; // YYYY-MM-DD (1º dia do mês)
    approvedHours: number;
    approvedCheckinAt: string | null;
    approvedCheckoutAt: string | null;
    approvedCheckinSource: 'app' | 'web_admin' | null;
    validatedBy: string;
  }): Promise<void> {
    const existing = await this.getOne(input.sourceShiftId);
    if (existing?.status === 'validado') throw new ShiftAlreadyValidatedError();

    await this.pool.query(
      `INSERT INTO shift_hours_validation
         (source, source_shift_id, ana_care_patient_id, ana_care_nurse_id, period_month,
          status, approved_hours, approved_checkin_at, approved_checkout_at, approved_checkin_source,
          validated_by, validated_at)
       VALUES ($1, $2, $3, $4, $5, 'validado', $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (source, source_shift_id) DO UPDATE SET
         status = 'validado',
         approved_hours = EXCLUDED.approved_hours,
         approved_checkin_at = EXCLUDED.approved_checkin_at,
         approved_checkout_at = EXCLUDED.approved_checkout_at,
         approved_checkin_source = EXCLUDED.approved_checkin_source,
         validated_by = EXCLUDED.validated_by,
         validated_at = NOW(),
         reason = NULL,
         updated_at = NOW()`,
      [
        SOURCE,
        input.sourceShiftId,
        input.anaCarePatientId,
        input.anaCareNurseId,
        input.periodMonth,
        input.approvedHours,
        input.approvedCheckinAt,
        input.approvedCheckoutAt,
        input.approvedCheckinSource,
        input.validatedBy,
      ],
    );
  }

  /**
   * Contestar: pendente/inexistente → contestado; contestado → contestado (corrige motivo/nota
   * antes de validar — não há regra contrária na spec). `validado` recusa ANTES do UPDATE (mesmo
   * motivo do `validate`) — "não se contesta duas vezes" a spec fala do botão sumir na UI; aqui é
   * o portão do backend.
   */
  async contest(input: {
    sourceShiftId: string;
    anaCarePatientId: string;
    anaCareNurseId: string;
    periodMonth: string;
    reason: ContestReason;
    noteEncrypted: string | null;
  }): Promise<void> {
    const existing = await this.getOne(input.sourceShiftId);
    if (existing?.status === 'validado') throw new ShiftAlreadyValidatedError();

    await this.pool.query(
      `INSERT INTO shift_hours_validation
         (source, source_shift_id, ana_care_patient_id, ana_care_nurse_id, period_month, status, reason, note_encrypted)
       VALUES ($1, $2, $3, $4, $5, 'contestado', $6, $7)
       ON CONFLICT (source, source_shift_id) DO UPDATE SET
         status = 'contestado',
         reason = EXCLUDED.reason,
         note_encrypted = EXCLUDED.note_encrypted,
         updated_at = NOW()`,
      [SOURCE, input.sourceShiftId, input.anaCarePatientId, input.anaCareNurseId, input.periodMonth, input.reason, input.noteEncrypted],
    );
  }
}
