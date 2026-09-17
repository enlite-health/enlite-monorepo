/**
 * src/modules/anacare-hours/infrastructure/AnaCarePatientMonthRepository.ts
 *
 * Acesso a `anacare_patient_month` (migration 441, D361) — o retrato AGREGADO por paciente+mês,
 * escrito pelo `AnaCareHoursSyncRunner` ao lado de `anacare_shift` (convivência da F6.1). A partir
 * da F6.2 a LISTA passa a ler daqui em vez de somar o array de turnos na hora.
 *
 * Mesmo molde de `AnaCareShiftRepository` (Pool + `DatabaseConnection`, UNNEST em lote, tipo de
 * linha SQL separado do tipo de domínio, mapeamento explícito).
 */

import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from '../domain/AnaCarePatientMonth';
import type { PatientMonthSyncRepository, ShiftSyncFreshness } from '../domain/AnaCareHoursSyncPorts';
import type { SourceShiftDTO } from '../domain/AnaCareShiftsSource';

interface AnaCarePatientMonthProviderRowSql {
  ana_care_patient_id: string;
  ana_care_nurse_id: string;
  nurse_first_name: string | null;
  nurse_last_name: string | null;
}

function toProviderAggregate(r: AnaCarePatientMonthProviderRowSql): AnaCarePatientMonthProviderAggregate {
  return {
    anaCarePatientId: r.ana_care_patient_id,
    anaCareNurseId: r.ana_care_nurse_id,
    nurseFirstName: r.nurse_first_name ?? undefined,
    nurseLastName: r.nurse_last_name ?? undefined,
  };
}

interface AnaCarePatientMonthRowSql {
  ana_care_patient_id: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  providers_count: number;
  shifts_count: number;
  hours_actual_sum: string;
  hours_scheduled_sum_missing_actual: string;
  origin_sin_checkin: number;
  origin_web_admin: number;
  origin_app: number;
}

function toAggregate(r: AnaCarePatientMonthRowSql): AnaCarePatientMonthAggregate {
  return {
    anaCarePatientId: r.ana_care_patient_id,
    patientFirstName: r.patient_first_name ?? undefined,
    patientLastName: r.patient_last_name ?? undefined,
    providersCount: Number(r.providers_count),
    shiftsCount: Number(r.shifts_count),
    hoursActualSum: Number(r.hours_actual_sum),
    hoursScheduledSumMissingActual: Number(r.hours_scheduled_sum_missing_actual),
    originSinCheckin: Number(r.origin_sin_checkin),
    originWebAdmin: Number(r.origin_web_admin),
    originApp: Number(r.origin_app),
  };
}

/** `period_month` da tabela é sempre o 1º dia do mês (CHECK, migration 441). */
function periodMonthDate(month: string): string {
  return `${month}-01`;
}

/** Mesmo critério de `AnaCarePatientMonthAggregator.nonEmpty` — nome em branco não conta como nome. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Conserto 17/09 (desacoplamento de `anacare_shift`, passo 1): `upsertReplacingForRun` faz
 * SUBSTITUIÇÃO (não soma) — não pode mesclar silenciosamente uma gravação do MESMO paciente vinda
 * de outra reserva. Falha ALTA (nunca grava o lote) antes de sobrescrever calado, mesmo molde de
 * `AnaCareShiftMonthMismatchError`.
 */
export class AnaCarePatientMonthCollisionError extends Error {
  constructor(
    readonly anaCarePatientIds: readonly string[],
    readonly periodMonth: string,
  ) {
    super(
      `[AnaCarePatientMonthRepository] paciente(s) ${anaCarePatientIds.join(', ')} do mês ${periodMonth} ` +
        `já foram gravados NESTA MESMA corrida (fetched_at >= runStartedAt) — outra reserva desta ` +
        `corrida já escreveu este paciente; substituir agora apagaria a gravação anterior em ` +
        `silêncio. Recusado sem gravar nada do lote.`,
    );
  }
}

export class AnaCarePatientMonthRepository implements PatientMonthSyncRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * Grava em LOTE via `UNNEST` (1 INSERT para N pacientes, nunca 1 query por paciente — mesmo
   * padrão de `AnaCareShiftRepository.upsertMany`). `source` é sempre `'anacare'` — a única fonte
   * hoje, mesma convenção do repositório irmão (constante interna, não parâmetro).
   */
  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[], periodMonth: string): Promise<{ written: number }> {
    if (aggregates.length === 0) return { written: 0 };

    const sources = aggregates.map(() => 'anacare');
    const periodMonthDates = aggregates.map(() => periodMonthDate(periodMonth));
    const patientIds = aggregates.map((a) => a.anaCarePatientId);
    const firstNames = aggregates.map((a) => a.patientFirstName ?? null);
    const lastNames = aggregates.map((a) => a.patientLastName ?? null);
    const providersCounts = aggregates.map((a) => a.providersCount);
    const shiftsCounts = aggregates.map((a) => a.shiftsCount);
    const hoursActualSums = aggregates.map((a) => a.hoursActualSum);
    const hoursScheduledSums = aggregates.map((a) => a.hoursScheduledSumMissingActual);
    const originSinCheckins = aggregates.map((a) => a.originSinCheckin);
    const originWebAdmins = aggregates.map((a) => a.originWebAdmin);
    const originApps = aggregates.map((a) => a.originApp);

    await this.pool.query(
      `INSERT INTO anacare_patient_month (
         source, ana_care_patient_id, period_month, patient_first_name, patient_last_name,
         providers_count, shifts_count, hours_actual_sum, hours_scheduled_sum_missing_actual,
         origin_sin_checkin, origin_web_admin, origin_app, fetched_at, updated_at
       )
       SELECT UNNEST($1::text[]), UNNEST($2::text[]), UNNEST($3::date[]), UNNEST($4::text[]), UNNEST($5::text[]),
              UNNEST($6::integer[]), UNNEST($7::integer[]), UNNEST($8::numeric[]), UNNEST($9::numeric[]),
              UNNEST($10::integer[]), UNNEST($11::integer[]), UNNEST($12::integer[]), NOW(), NOW()
       ON CONFLICT (source, ana_care_patient_id, period_month) DO UPDATE SET
         patient_first_name                 = EXCLUDED.patient_first_name,
         patient_last_name                  = EXCLUDED.patient_last_name,
         providers_count                    = EXCLUDED.providers_count,
         shifts_count                       = EXCLUDED.shifts_count,
         hours_actual_sum                   = EXCLUDED.hours_actual_sum,
         hours_scheduled_sum_missing_actual = EXCLUDED.hours_scheduled_sum_missing_actual,
         origin_sin_checkin                 = EXCLUDED.origin_sin_checkin,
         origin_web_admin                   = EXCLUDED.origin_web_admin,
         origin_app                         = EXCLUDED.origin_app,
         fetched_at                         = NOW(),
         updated_at                         = NOW()`,
      [
        sources,
        patientIds,
        periodMonthDates,
        firstNames,
        lastNames,
        providersCounts,
        shiftsCounts,
        hoursActualSums,
        hoursScheduledSums,
        originSinCheckins,
        originWebAdmins,
        originApps,
      ],
    );

    return { written: aggregates.length };
  }

  /**
   * Conserto 17/09 (D361 F6.1): NUNCA agrega em memória por reserva — o mesmo paciente pode
   * aparecer em duas reservas, inclusive em invocações diferentes (retomada por cursor), e um
   * upsert que só via os turnos de UMA reserva fazia a segunda gravação SOBRESCREVER a primeira em
   * silêncio. Aqui o `INSERT ... SELECT ... GROUP BY` recomputa direto de `anacare_shift` (fonte da
   * verdade cumulativa durante a convivência F6.1, já escrita pelo `AnaCareShiftRepository.upsertMany`
   * imediatamente antes desta chamada) — o valor gravado é sempre o TOTAL do paciente no mês, venha
   * de quantas reservas vier e em quantas invocações for.
   *
   * `anacare_shift` NÃO tem colunas de nome (migration 440 nunca foi aplicada) — o nome continua
   * vindo dos `shifts` em memória (mesma regra de `aggregatePatientMonth`: primeiro valor
   * não-vazio, por paciente, DENTRO deste lote) e é passado como parâmetro; no `ON CONFLICT`, o
   * `COALESCE(EXCLUDED.*, anacare_patient_month.*)` garante que uma rodada sem nome NUNCA apaga um
   * nome já gravado (vazio ambíguo apagando dado — regra dura da casa).
   */
  async recomputeFromShifts(shifts: readonly SourceShiftDTO[], periodMonth: string): Promise<{ written: number }> {
    if (shifts.length === 0) return { written: 0 };

    const namesByPatient = new Map<string, { firstName?: string; lastName?: string }>();
    for (const s of shifts) {
      if (namesByPatient.has(s.anaCarePatientId)) continue;
      const firstName = nonEmpty(s.patientFirstName);
      const lastName = nonEmpty(s.patientLastName);
      if (firstName || lastName) namesByPatient.set(s.anaCarePatientId, { firstName, lastName });
    }

    const patientIds = [...new Set(shifts.map((s) => s.anaCarePatientId))];
    const firstNames = patientIds.map((id) => namesByPatient.get(id)?.firstName ?? null);
    const lastNames = patientIds.map((id) => namesByPatient.get(id)?.lastName ?? null);
    const periodMonthValue = periodMonthDate(periodMonth);

    await this.pool.query(
      `INSERT INTO anacare_patient_month (
         source, ana_care_patient_id, period_month, patient_first_name, patient_last_name,
         providers_count, shifts_count, hours_actual_sum, hours_scheduled_sum_missing_actual,
         origin_sin_checkin, origin_web_admin, origin_app, fetched_at, updated_at
       )
       SELECT
         'anacare',
         s.ana_care_patient_id,
         $1::date,
         names.first_name,
         names.last_name,
         COUNT(DISTINCT s.ana_care_nurse_id)::integer AS providers_count,
         COUNT(*)::integer AS shifts_count,
         -- hours_actual_sum: só turnos com checkin_at E checkout_at (mesma regra de computeActualHours).
         COALESCE(SUM(
           CASE WHEN s.checkin_at IS NOT NULL AND s.checkout_at IS NOT NULL
             THEN ROUND((EXTRACT(EPOCH FROM (s.checkout_at - s.checkin_at)) / 3600.0)::numeric, 2)
             ELSE 0 END
         ), 0) AS hours_actual_sum,
         -- hours_scheduled_sum_missing_actual: previsto só dos turnos SEM hora real (mesma regra de hoursScheduledOf).
         COALESCE(SUM(
           CASE WHEN s.checkin_at IS NULL OR s.checkout_at IS NULL THEN
             CASE WHEN s.planned_start IS NOT NULL AND s.planned_end IS NOT NULL
               THEN ROUND((EXTRACT(EPOCH FROM (s.planned_end - s.planned_start)) / 3600.0)::numeric, 2)
               ELSE 0 END
             ELSE 0 END
         ), 0) AS hours_scheduled_sum_missing_actual,
         COUNT(*) FILTER (WHERE s.checkin_source IS NULL)::integer AS origin_sin_checkin,
         COUNT(*) FILTER (WHERE s.checkin_source = 'web_admin')::integer AS origin_web_admin,
         COUNT(*) FILTER (WHERE s.checkin_source IS NOT NULL AND s.checkin_source <> 'web_admin')::integer AS origin_app,
         NOW(),
         NOW()
         FROM anacare_shift s
         JOIN (
           SELECT UNNEST($2::text[]) AS patient_id, UNNEST($3::text[]) AS first_name, UNNEST($4::text[]) AS last_name
         ) names ON names.patient_id = s.ana_care_patient_id
        WHERE s.source = 'anacare' AND s.period_month = $1::date AND s.ana_care_patient_id = ANY($2::text[])
        GROUP BY s.ana_care_patient_id, names.first_name, names.last_name
       ON CONFLICT (source, ana_care_patient_id, period_month) DO UPDATE SET
         patient_first_name                 = COALESCE(EXCLUDED.patient_first_name, anacare_patient_month.patient_first_name),
         patient_last_name                  = COALESCE(EXCLUDED.patient_last_name, anacare_patient_month.patient_last_name),
         providers_count                    = EXCLUDED.providers_count,
         shifts_count                       = EXCLUDED.shifts_count,
         hours_actual_sum                   = EXCLUDED.hours_actual_sum,
         hours_scheduled_sum_missing_actual = EXCLUDED.hours_scheduled_sum_missing_actual,
         origin_sin_checkin                 = EXCLUDED.origin_sin_checkin,
         origin_web_admin                   = EXCLUDED.origin_web_admin,
         origin_app                         = EXCLUDED.origin_app,
         fetched_at                         = NOW(),
         updated_at                         = NOW()`,
      [periodMonthValue, patientIds, firstNames, lastNames],
    );

    await this.upsertProvidersFromShifts(shifts, periodMonthValue);

    return { written: patientIds.length };
  }

  /**
   * Adendo 17/09 (D361): grava o PAR paciente×prestador×mês (migration 442) — a companheira que
   * alimenta o filtro "Todos los prestadores". Só usa os pares presentes NESTE lote de `shifts`
   * (não precisa recomputar contra `anacare_shift` como o agregado faz: um par já gravado por uma
   * reserva anterior nunca é apagado por esta chamada — o `ON CONFLICT` só ADICIONA/atualiza nome,
   * nunca remove uma linha, então a convivência entre reservas/invocações é segura por construção).
   * Nome: mesma regra de `recomputeFromShifts` para o paciente — primeiro valor não-vazio DENTRO
   * deste lote vence; `COALESCE` no `ON CONFLICT` garante que uma rodada sem nome nunca apaga um
   * nome de prestador já gravado.
   */
  private async upsertProvidersFromShifts(shifts: readonly SourceShiftDTO[], periodMonthValue: string): Promise<void> {
    const namesByPair = new Map<string, { firstName?: string; lastName?: string }>();
    const pairPatientIds: string[] = [];
    const pairNurseIds: string[] = [];
    for (const s of shifts) {
      const key = `${s.anaCarePatientId}::${s.anaCareNurseId}`;
      if (!namesByPair.has(key)) {
        pairPatientIds.push(s.anaCarePatientId);
        pairNurseIds.push(s.anaCareNurseId);
        namesByPair.set(key, {});
      }
      const entry = namesByPair.get(key)!;
      if (entry.firstName || entry.lastName) continue; // primeiro não-vazio já venceu neste lote
      const firstName = nonEmpty(s.nurseFirstName);
      const lastName = nonEmpty(s.nurseLastName);
      if (firstName || lastName) {
        entry.firstName = firstName;
        entry.lastName = lastName;
      }
    }

    if (pairPatientIds.length === 0) return;

    const firstNames = pairPatientIds.map((patientId, i) => namesByPair.get(`${patientId}::${pairNurseIds[i]}`)?.firstName ?? null);
    const lastNames = pairPatientIds.map((patientId, i) => namesByPair.get(`${patientId}::${pairNurseIds[i]}`)?.lastName ?? null);

    await this.pool.query(
      `INSERT INTO anacare_patient_month_provider (
         source, ana_care_patient_id, ana_care_nurse_id, period_month, nurse_first_name, nurse_last_name,
         fetched_at, created_at, updated_at
       )
       SELECT 'anacare', UNNEST($2::text[]), UNNEST($3::text[]), $1::date, UNNEST($4::text[]), UNNEST($5::text[]), NOW(), NOW(), NOW()
       ON CONFLICT (source, ana_care_patient_id, ana_care_nurse_id, period_month) DO UPDATE SET
         nurse_first_name = COALESCE(EXCLUDED.nurse_first_name, anacare_patient_month_provider.nurse_first_name),
         nurse_last_name  = COALESCE(EXCLUDED.nurse_last_name, anacare_patient_month_provider.nurse_last_name),
         fetched_at        = NOW(),
         updated_at         = NOW()`,
      [periodMonthValue, pairPatientIds, pairNurseIds, firstNames, lastNames],
    );
  }

  /**
   * Ver contrato em `PatientMonthSyncRepository.upsertReplacingForRun`. Transação: `SELECT ...
   * FOR UPDATE` trava as linhas dos pacientes do lote ANTES de decidir — evita que duas reservas
   * concorrentes da MESMA corrida passem as duas pela checagem antes de qualquer uma escrever.
   */
  async upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    periodMonth: string,
    runStartedAt: Date,
  ): Promise<{ written: number }> {
    if (aggregates.length === 0) return { written: 0 };

    const periodMonthValue = periodMonthDate(periodMonth);
    const patientIds = aggregates.map((a) => a.anaCarePatientId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const collisionCheck = await client.query<{ ana_care_patient_id: string }>(
        `SELECT ana_care_patient_id
           FROM anacare_patient_month
          WHERE source = 'anacare' AND period_month = $1 AND ana_care_patient_id = ANY($2::text[])
            AND fetched_at >= $3::timestamptz
          FOR UPDATE`,
        [periodMonthValue, patientIds, runStartedAt.toISOString()],
      );

      if (collisionCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new AnaCarePatientMonthCollisionError(
          collisionCheck.rows.map((r) => r.ana_care_patient_id),
          periodMonth,
        );
      }

      const sources = aggregates.map(() => 'anacare');
      const periodMonthDates = aggregates.map(() => periodMonthValue);
      const firstNames = aggregates.map((a) => a.patientFirstName ?? null);
      const lastNames = aggregates.map((a) => a.patientLastName ?? null);
      const providersCounts = aggregates.map((a) => a.providersCount);
      const shiftsCounts = aggregates.map((a) => a.shiftsCount);
      const hoursActualSums = aggregates.map((a) => a.hoursActualSum);
      const hoursScheduledSums = aggregates.map((a) => a.hoursScheduledSumMissingActual);
      const originSinCheckins = aggregates.map((a) => a.originSinCheckin);
      const originWebAdmins = aggregates.map((a) => a.originWebAdmin);
      const originApps = aggregates.map((a) => a.originApp);

      const result = await client.query(
        `INSERT INTO anacare_patient_month (
           source, ana_care_patient_id, period_month, patient_first_name, patient_last_name,
           providers_count, shifts_count, hours_actual_sum, hours_scheduled_sum_missing_actual,
           origin_sin_checkin, origin_web_admin, origin_app, fetched_at, updated_at
         )
         SELECT UNNEST($1::text[]), UNNEST($2::text[]), UNNEST($3::date[]), UNNEST($4::text[]), UNNEST($5::text[]),
                UNNEST($6::integer[]), UNNEST($7::integer[]), UNNEST($8::numeric[]), UNNEST($9::numeric[]),
                UNNEST($10::integer[]), UNNEST($11::integer[]), UNNEST($12::integer[]), NOW(), NOW()
         ON CONFLICT (source, ana_care_patient_id, period_month) DO UPDATE SET
           patient_first_name                 = COALESCE(EXCLUDED.patient_first_name, anacare_patient_month.patient_first_name),
           patient_last_name                  = COALESCE(EXCLUDED.patient_last_name, anacare_patient_month.patient_last_name),
           providers_count                    = EXCLUDED.providers_count,
           shifts_count                       = EXCLUDED.shifts_count,
           hours_actual_sum                   = EXCLUDED.hours_actual_sum,
           hours_scheduled_sum_missing_actual = EXCLUDED.hours_scheduled_sum_missing_actual,
           origin_sin_checkin                 = EXCLUDED.origin_sin_checkin,
           origin_web_admin                   = EXCLUDED.origin_web_admin,
           origin_app                         = EXCLUDED.origin_app,
           fetched_at                         = NOW(),
           updated_at                         = NOW()`,
        [
          sources,
          patientIds,
          periodMonthDates,
          firstNames,
          lastNames,
          providersCounts,
          shiftsCounts,
          hoursActualSums,
          hoursScheduledSums,
          originSinCheckins,
          originWebAdmins,
          originApps,
        ],
      );

      await client.query('COMMIT');
      // Contagem zero é falha, nunca sucesso — `rowCount` é o que REALMENTE foi gravado, nunca o
      // tamanho do array de entrada (que já foi validado > 0 acima).
      return { written: result.rowCount ?? 0 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listProvidersByMonth(source: string, periodMonth: string): Promise<AnaCarePatientMonthProviderAggregate[]> {
    const res = await this.pool.query<AnaCarePatientMonthProviderRowSql>(
      `SELECT ana_care_patient_id, ana_care_nurse_id, nurse_first_name, nurse_last_name
         FROM anacare_patient_month_provider
        WHERE source = $1 AND period_month = $2
        ORDER BY ana_care_patient_id, ana_care_nurse_id`,
      [source, periodMonthDate(periodMonth)],
    );
    return res.rows.map(toProviderAggregate);
  }

  async listByMonth(source: string, periodMonth: string): Promise<AnaCarePatientMonthAggregate[]> {
    const res = await this.pool.query<AnaCarePatientMonthRowSql>(
      `SELECT ana_care_patient_id, patient_first_name, patient_last_name,
              providers_count, shifts_count, hours_actual_sum, hours_scheduled_sum_missing_actual,
              origin_sin_checkin, origin_web_admin, origin_app
         FROM anacare_patient_month
        WHERE source = $1 AND period_month = $2
        ORDER BY ana_care_patient_id`,
      [source, periodMonthDate(periodMonth)],
    );
    return res.rows.map(toAggregate);
  }

  /** `shifts=0` ⇒ retrato agregado NUNCA construído para o mês (contagem zero é falha, nunca sucesso — regra dura). */
  async getSnapshotFreshness(source: string, periodMonth: string): Promise<ShiftSyncFreshness> {
    const res = await this.pool.query<{ count: string; last_fetched_at: string | null }>(
      `SELECT COUNT(*)::text AS count, MAX(fetched_at) AS last_fetched_at
         FROM anacare_patient_month
        WHERE source = $1 AND period_month = $2`,
      [source, periodMonthDate(periodMonth)],
    );
    const row = res.rows[0];
    const shifts = row ? Number(row.count) : 0;
    return { shifts, lastFetchedAt: shifts > 0 ? (row?.last_fetched_at ?? null) : null };
  }
}
