import type { CountryCode } from '@shared/domain/countryCodes';

/**
 * Horas/semana do serviço contratado, agregadas dos serviços com vaga viva (spec 056 §8).
 * `total` = Σ faixas vigentes; `cobertas` = Σ faixas com alocação vigente. Implementado por
 * `case/infrastructure/ServiceHoursSummaryReader` (única definição da soma).
 */
export interface ServiceHoursSummary {
  total: number;
  cobertas: number;
  /** Serviços com vaga viva e ≥ 1 faixa vigente. */
  servicesWithSchedule: number;
  /** Serviços com vaga viva e nenhuma faixa vigente. */
  servicesWithoutSchedule: number;
}

export interface ServiceHoursSummaryPort {
  readServiceHours(countries: CountryCode[], now?: Date): Promise<ServiceHoursSummary>;
}
