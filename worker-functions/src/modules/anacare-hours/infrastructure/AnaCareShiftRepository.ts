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
  /** Rótulo de exibição do retrato (migration 440) — vem do payload do turno, não de `patients`/`workers`. */
  patient_first_name: string | null;
  patient_last_name: string | null;
  nurse_first_name: string | null;
  nurse_last_name: string | null;
}

function toDTO(r: AnaCareShiftRowSql): SourceShiftDTO {
  return {
    sourceShiftId: r.source_shift_id,
    anaCarePatientId: r.ana_care_patient_id,
    anaCareNurseId: r.ana_care_nurse_id,
    date: r.shift_date,
    patientFirstName: r.patient_first_name,
    patientLastName: r.patient_last_name,
    nurseFirstName: r.nurse_first_name,
    nurseLastName: r.nurse_last_name,
    // Item 7 (revisão de PR): nulo explícito, propagado até o mapper — nunca mais `?? ''` aqui.
    // `''` não é um horário válido; fingir que é produzia `NaN` em `hoursBetween('', '')`.
    scheduledStart: r.planned_start,
    scheduledEnd: r.planned_end,
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

/**
 * Achado 4 (item 4 da revisão de raiz, 17/09): antes, `period_month` era só o que o CHAMADOR
 * pedia — nenhuma checagem contra o que a própria fonte afirma (`SourceShiftDTO.sourceMonth`,
 * `raw.month` medido presente em 88/88 turnos). Gravar calado num mês errado é pior que falhar:
 * um turno de agosto entrando silenciosamente no retrato de setembro corrompe as DUAS listas sem
 * nenhum sinal. Falha ALTA (lança, não grava nada do lote) — nunca best-effort silencioso.
 */
export class AnaCareShiftMonthMismatchError extends Error {
  constructor(
    readonly sourceShiftId: string,
    readonly sourceMonth: string,
    readonly requestedMonth: string,
  ) {
    super(
      `[AnaCareShiftRepository] turno ${sourceShiftId}: a fonte afirma mês ${sourceMonth}, mas o ` +
        `upsert foi pedido para ${requestedMonth} — recusado (gravar calado no mês errado corrompe ` +
        `o retrato sem nenhum sinal).`,
    );
  }
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

    // Falha ALTA antes de gravar qualquer coisa do lote — ver `AnaCareShiftMonthMismatchError`.
    for (const s of shifts) {
      if (s.sourceMonth && s.sourceMonth !== periodMonth) {
        throw new AnaCareShiftMonthMismatchError(s.sourceShiftId, s.sourceMonth, periodMonth);
      }
    }

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
    // Item 2 (revisão de PR): grava o dia direto da FONTE — nunca derivado de `planned_start` na
    // leitura (round-trip fiel, sem timezone de sessão nem "vira o 1º do mês" quando nulo).
    const shiftDates = shifts.map((s) => s.date);
    // Item 5 (conserto de raiz 17/09): colunas existem desde a migration 437, gravadas NULAS por
    // falta de campo no DTO — `?? null` cobre o DTO que não os carrega (round-trip de leitura).
    const checkoutSources = shifts.map((s) => s.checkoutSource ?? null);
    const checkinDelays = shifts.map((s) => s.checkinDelay ?? null);
    // Item 1 (nome e sobrenome, migration 440): rótulo de exibição do retrato, vem do payload do
    // turno — `?? null` cobre o DTO que não os carrega (round-trip de leitura).
    const patientFirstNames = shifts.map((s) => s.patientFirstName ?? null);
    const patientLastNames = shifts.map((s) => s.patientLastName ?? null);
    const nurseFirstNames = shifts.map((s) => s.nurseFirstName ?? null);
    const nurseLastNames = shifts.map((s) => s.nurseLastName ?? null);

    await this.pool.query(
      `INSERT INTO anacare_shift (
         source, source_shift_id, ana_care_patient_id, ana_care_nurse_id, period_month,
         planned_start, planned_end, checkin_at, checkout_at, checkin_source, is_finalized,
         shift_date, checkout_source, checkin_delay, patient_first_name, patient_last_name,
         nurse_first_name, nurse_last_name, fetched_at, updated_at
       )
       SELECT $1::text, UNNEST($2::text[]), UNNEST($3::text[]), UNNEST($4::text[]), UNNEST($5::date[]),
              UNNEST($6::timestamptz[]), UNNEST($7::timestamptz[]), UNNEST($8::timestamptz[]), UNNEST($9::timestamptz[]),
              UNNEST($10::text[]), UNNEST($11::boolean[]), UNNEST($12::date[]), UNNEST($13::text[]), UNNEST($14::numeric[]),
              UNNEST($15::text[]), UNNEST($16::text[]), UNNEST($17::text[]), UNNEST($18::text[]), NOW(), NOW()
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
         shift_date          = EXCLUDED.shift_date,
         checkout_source     = EXCLUDED.checkout_source,
         checkin_delay       = EXCLUDED.checkin_delay,
         patient_first_name  = EXCLUDED.patient_first_name,
         patient_last_name     = EXCLUDED.patient_last_name,
         nurse_first_name    = EXCLUDED.nurse_first_name,
         nurse_last_name       = EXCLUDED.nurse_last_name,
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
        shiftDates,
        checkoutSources,
        checkinDelays,
        patientFirstNames,
        patientLastNames,
        nurseFirstNames,
        nurseLastNames,
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
      // `shift_date::text`, não o valor cru: o driver `pg` parseia a coluna `date` nativa como
      // objeto `Date` (sem timezone, mas ainda assim não é o `string` do contrato SQL→DTO) —
      // `::text` sobre `date` é formatação pura ('YYYY-MM-DD'), não conversão de timezone (isso só
      // existe em timestamptz), então não reabre o bug do item 2.
      `SELECT source_shift_id, ana_care_patient_id, ana_care_nurse_id,
              planned_start, planned_end, checkin_at, checkout_at, checkin_source, is_finalized,
              shift_date::text AS shift_date,
              patient_first_name, patient_last_name, nurse_first_name, nurse_last_name
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
