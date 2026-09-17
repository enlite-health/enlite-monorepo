/**
 * src/modules/anacare-hours/infrastructure/AnaCareShiftRepository.ts
 *
 * Acesso a `anacare_shift` (migration 437, colunas novas em 439) — o RETRATO do turno, escrito
 * pelo `AnaCareHoursSyncRunner` (sync real, por reserva) e lido pela LISTA do mês
 * (`AnaCareHoursService.getMonthSnapshot`). O DETALHE (`getPatientMonth`) nunca passa por aqui —
 * vai ao vivo na fonte (`AnaCareShiftsSource`), spec §Assimetria lista×detalhe.
 *
 * Mesmo molde de `ShiftHoursValidationRepository` (Pool + `DatabaseConnection`, tipo de linha SQL
 * separado do tipo de domínio, mapeamento explícito).
 */

import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { ShiftSyncFreshness, ShiftSyncRepository } from '../domain/AnaCareHoursSyncPorts';

const SOURCE = 'anacare';

interface AnaCareShiftRowSql {
  source_shift_id: string;
  ana_care_patient_id: string;
  ana_care_nurse_id: string;
  planned_start: string | null;
  planned_end: string | null;
  checkin_at: string | null;
  checkout_at: string | null;
  checkin_source: 'app' | 'web_admin' | null;
  is_finalized: boolean;
  /** YYYY-MM-DD (data do turno) — só truncamos period_month ao dia no domínio, spec §Contrato de dados. */
  shift_date: string;
}

function toDTO(r: AnaCareShiftRowSql): SourceShiftDTO {
  return {
    sourceShiftId: r.source_shift_id,
    anaCarePatientId: r.ana_care_patient_id,
    anaCareNurseId: r.ana_care_nurse_id,
    date: r.shift_date,
    scheduledStart: r.planned_start ?? '',
    scheduledEnd: r.planned_end ?? '',
    actualStart: r.checkin_at,
    actualEnd: r.checkout_at,
    checkinSource: r.checkin_source,
    isFinalized: r.is_finalized,
  };
}

/** `period_month` da tabela é sempre o 1º dia do mês (CHECK, migration 437). */
function periodMonthDate(month: string): string {
  return `${month}-01`;
}

export class AnaCareShiftRepository implements ShiftSyncRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * Grava em LOTE via `UNNEST` (1 INSERT para N turnos, nunca 1 query por turno — mesmo padrão
   * de `EncuadreRepository`). `fetched_at`/`updated_at` sempre `NOW()` no upsert — é o carimbo que
   * `getSnapshotFreshness` usa para "construído e há quanto tempo".
   */
  async upsertMany(shifts: readonly SourceShiftDTO[], periodMonth: string): Promise<{ written: number }> {
    if (shifts.length === 0) return { written: 0 };

    const periodMonthDates = shifts.map(() => periodMonthDate(periodMonth));
    const sourceShiftIds = shifts.map((s) => s.sourceShiftId);
    const patientIds = shifts.map((s) => s.anaCarePatientId);
    const nurseIds = shifts.map((s) => s.anaCareNurseId);
    const plannedStarts = shifts.map((s) => s.scheduledStart || null);
    const plannedEnds = shifts.map((s) => s.scheduledEnd || null);
    const checkinAts = shifts.map((s) => s.actualStart);
    const checkoutAts = shifts.map((s) => s.actualEnd);
    const checkinSources = shifts.map((s) => s.checkinSource);
    const isFinalizeds = shifts.map((s) => s.isFinalized);

    await this.pool.query(
      `INSERT INTO anacare_shift (
         source, source_shift_id, ana_care_patient_id, ana_care_nurse_id, period_month,
         planned_start, planned_end, checkin_at, checkout_at, checkin_source, is_finalized,
         fetched_at, updated_at
       )
       SELECT $1::text, UNNEST($2::text[]), UNNEST($3::text[]), UNNEST($4::text[]), UNNEST($5::date[]),
              UNNEST($6::timestamptz[]), UNNEST($7::timestamptz[]), UNNEST($8::timestamptz[]), UNNEST($9::timestamptz[]),
              UNNEST($10::text[]), UNNEST($11::boolean[]), NOW(), NOW()
       ON CONFLICT (source, source_shift_id) DO UPDATE SET
         ana_care_patient_id = EXCLUDED.ana_care_patient_id,
         ana_care_nurse_id   = EXCLUDED.ana_care_nurse_id,
         period_month        = EXCLUDED.period_month,
         planned_start       = EXCLUDED.planned_start,
         planned_end         = EXCLUDED.planned_end,
         checkin_at          = EXCLUDED.checkin_at,
         checkout_at         = EXCLUDED.checkout_at,
         checkin_source      = EXCLUDED.checkin_source,
         is_finalized        = EXCLUDED.is_finalized,
         fetched_at          = NOW(),
         updated_at          = NOW()`,
      [
        SOURCE,
        sourceShiftIds,
        patientIds,
        nurseIds,
        periodMonthDates,
        plannedStarts,
        plannedEnds,
        checkinAts,
        checkoutAts,
        checkinSources,
        isFinalizeds,
      ],
    );

    return { written: shifts.length };
  }

  /**
   * Lê o retrato JÁ GRAVADO — a LISTA nunca chama a fonte (`AnaCareShiftsSource`), spec
   * §Assimetria lista×detalhe. Devolve o MESMO tipo que a porta devolve (`SourceShiftDTO[]`) —
   * o serviço/mapper não sabem se o dado veio do banco ou ao vivo.
   */
  async listByMonth(month: string, patientId?: string): Promise<SourceShiftDTO[]> {
    const params: unknown[] = [SOURCE, periodMonthDate(month)];
    let where = 'source = $1 AND period_month = $2';
    if (patientId) {
      params.push(patientId);
      where += ` AND ana_care_patient_id = $${params.length}`;
    }
    const res = await this.pool.query<AnaCareShiftRowSql>(
      `SELECT source_shift_id, ana_care_patient_id, ana_care_nurse_id,
              planned_start, planned_end, checkin_at, checkout_at, checkin_source, is_finalized,
              to_char(COALESCE(planned_start, period_month), 'YYYY-MM-DD') AS shift_date
         FROM anacare_shift
        WHERE ${where}
        ORDER BY source_shift_id`,
      params,
    );
    return res.rows.map(toDTO);
  }

  /** `shifts=0` ⇒ retrato NUNCA construído para o mês (contagem zero é falha, nunca sucesso — regra dura). */
  async getSnapshotFreshness(month: string): Promise<ShiftSyncFreshness> {
    const res = await this.pool.query<{ count: string; last_fetched_at: string | null }>(
      `SELECT COUNT(*)::text AS count, MAX(fetched_at) AS last_fetched_at
         FROM anacare_shift
        WHERE source = $1 AND period_month = $2`,
      [SOURCE, periodMonthDate(month)],
    );
    const row = res.rows[0];
    const shifts = row ? Number(row.count) : 0;
    return { shifts, lastFetchedAt: shifts > 0 ? (row?.last_fetched_at ?? null) : null };
  }

  /** Última contagem TOTAL conhecida do diretório Enlite (`anacare_directory_snapshot`, migration 439). `null` = primeira execução. */
  async getLastDirectoryCount(): Promise<number | null> {
    const res = await this.pool.query<{ last_total_count: number }>(
      `SELECT last_total_count FROM anacare_directory_snapshot WHERE id = 1`,
    );
    return res.rows[0] ? Number(res.rows[0].last_total_count) : null;
  }

  async setLastDirectoryCount(count: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO anacare_directory_snapshot (id, last_total_count, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_total_count = EXCLUDED.last_total_count, updated_at = NOW()`,
      [count],
    );
  }
}
