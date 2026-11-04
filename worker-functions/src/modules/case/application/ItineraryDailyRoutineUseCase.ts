/**
 * ItineraryDailyRoutineUseCase — a rotina diária do itinerário (spec 069 F4, P11/P12): DERIVAÇÃO do estado → ALERTA "Sin cubrir".
 *
 * Chamada pelo Cloud Scheduler (`POST /api/internal/itinerary/daily`, 06:00 America/Argentina/Buenos_Aires). Ordem fixa:
 *   por país: grava `itinerary_daily_run` (idempotente) → reavalia TODO paciente sujeito à derivação e com itinerário montado
 *   (P12: por ESTADO, não por borda de data — um dia de job parado não perde transição; uma `withActorContext` por paciente, a MESMA
 *   `PatientStatusDerivation.run`, que move por `movePatientStatus(…, 'system')`; erro isolado e contado);
 *   depois, UMA vez para todos os países: o alerta (`UncoveredShiftsAlertUseCase`) — só depois da derivação, para o estado e o aviso
 *   do dia verem o mesmo mundo; por fim carimba `finished_at`/`failures` de cada país. Falha do alerta entra no `failures` de todos os
 *   países (registro conservador: "algo falhou hoje"). A data de operação é a do PAÍS (`operationDateOf`, nunca `toISOString()`).
 * Idempotente: re-chamar no dia não duplica aviso nem estado (`unchanged` não escreve; a PK do despacho barra o aviso).
 * Log só com contagens. O `moved` é contado aqui; o `not_ready` (hoje só `logger.warn` por paciente) também.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { reportError } from '@shared/logging';
import { operationDateOf } from '@shared/locale/operationDate';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from './PatientStatusDerivation';
import { ItineraryDailyRunRepository } from '../infrastructure/ItineraryDailyRunRepository';
import { UncoveredShiftsAlertUseCase, type UncoveredAlertResult } from './UncoveredShiftsAlertUseCase';

export interface CountryRoutineResult {
  operationDate: string;
  patientsChecked: number;
  moved: number;
  unchanged: number;
  notReady: number;
  failures: number;
}

export interface ItineraryDailyResult {
  countries: Record<string, CountryRoutineResult>;
  alert: UncoveredAlertResult;
}

export class ItineraryDailyRoutineUseCase {
  private poolMemo?: Pool;

  constructor(
    private readonly runs: ItineraryDailyRunRepository = new ItineraryDailyRunRepository(),
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
    private readonly alert: Pick<UncoveredShiftsAlertUseCase, 'execute'> = new UncoveredShiftsAlertUseCase(),
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async execute(input: { now: Date; countries: readonly string[] }): Promise<ItineraryDailyResult> {
    const countries: Record<string, CountryRoutineResult> = {};
    for (const country of input.countries) {
      countries[country] = await this.deriveCountry(country, input.now);
    }

    const alert = await this.alert.execute({ now: input.now, countries: input.countries });

    for (const country of input.countries) {
      const { operationDate, failures } = countries[country];
      await withActorContext(this.pool, (client) => this.runs.finish(client, country, operationDate, failures + alert.failures));
    }
    return { countries, alert };
  }

  private async deriveCountry(country: string, now: Date): Promise<CountryRoutineResult> {
    const operationDate = operationDateOf(country, now);
    const out: CountryRoutineResult = { operationDate, patientsChecked: 0, moved: 0, unchanged: 0, notReady: 0, failures: 0 };
    await withActorContext(this.pool, (client) => this.runs.begin(client, country, operationDate));
    const patientIds = await withActorContext(this.pool, (client) => this.runs.listDerivationCandidates(client, country));
    for (const patientId of patientIds) {
      out.patientsChecked++;
      try {
        const outcome = await withActorContext(this.pool, (client) => this.derivation.run(client, patientId, now));
        if (outcome === 'moved') out.moved++;
        else if (outcome === 'not_ready') out.notReady++;
        else out.unchanged++;
      } catch (err) {
        out.failures++;
        reportError(err instanceof Error ? err : new Error(String(err)), { source: 'ItineraryDailyRoutineUseCase:derive', country, patientId });
      }
    }
    return out;
  }
}
