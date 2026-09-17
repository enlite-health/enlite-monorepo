/**
 * src/modules/anacare-hours/domain/AnaCarePatientMonth.ts
 *
 * Tipo do retrato AGREGADO por paciente+mês (D361, `anacare-conferencia-de-horas` fase-6.md,
 * migration 441) — uma linha por `(source, ana_care_patient_id, period_month)`. Espelha
 * literalmente as colunas de `anacare_patient_month`; a função pura que produz este shape a
 * partir de `SourceShiftDTO[]` vive em `application/AnaCarePatientMonthAggregator.ts` (F6.1), e o
 * acesso a banco em `infrastructure/AnaCarePatientMonthRepository.ts`.
 */

export interface AnaCarePatientMonthAggregate {
  anaCarePatientId: string;
  /** Primeiro valor não-vazio entre os turnos do paciente no mês (ver Aggregator). */
  patientFirstName?: string;
  patientLastName?: string;
  /** Nº de `anaCareNurseId` DISTINTOS entre os turnos do paciente. */
  providersCount: number;
  shiftsCount: number;
  /** Soma das horas REAIS (check-in E checkout) — turno sem os dois não entra aqui. */
  hoursActualSum: number;
  /** Soma do PREVISTO só dos turnos SEM hora real — nunca some com `hoursActualSum` para o modo `zero`. */
  hoursScheduledSumMissingActual: number;
  originSinCheckin: number;
  originWebAdmin: number;
  originApp: number;
}

/**
 * Par paciente×prestador×mês (migration 442, Adendo 17/09 — D361) — QUEM cuidou de quem no mês,
 * sem dia nem hora. Alimenta o filtro "Todos los prestadores" e o conjunto `providers` do contrato
 * da lista (F6.2) — `providersByMonth` no repositório, agrupado por paciente pelo serviço.
 */
export interface AnaCarePatientMonthProviderAggregate {
  anaCarePatientId: string;
  anaCareNurseId: string;
  /** Mesma regra de `patientFirstName`/`patientLastName` — primeiro valor não-vazio vence. */
  nurseFirstName?: string;
  nurseLastName?: string;
}
