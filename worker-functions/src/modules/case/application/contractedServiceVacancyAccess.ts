/**
 * contractedServiceVacancyAccess — o ÚNICO ponto que decide se um ator lê a VAGA VIVA de um serviço
 * contratado (spec 047, F2). Mesmo molde de `contractedServiceHourlyValueAccess` (irmão, mesmo
 * `HourlyValueActor`): a célula é `vacancy:read` — a mesma da lista de vagas do paciente — e
 * `cells === null` (engine não decidiu, família fora do enforcement) cai no papel `admin`.
 *
 * 🔒 Vazio ambíguo não é ausência: `liveVacancy: null` sozinho confundiria "o serviço não tem vaga"
 * com "você não pode ver a vaga", e a tela ofereceria "ativar recrutamento" a quem só não enxerga.
 * Por isso o flag: sem a célula → `liveVacancy: null` + `liveVacancyRedacted: true`; com a célula e
 * sem vaga → `null` + `false`.
 */
import type { HourlyValueActor } from './contractedServiceHourlyValueAccess';

export const VACANCY_READ_CELL = 'vacancy:read';

export function canReadLiveVacancy(actor: HourlyValueActor): boolean {
  if (actor.cells !== null) return actor.cells.includes(VACANCY_READ_CELL);
  return actor.roles === null || actor.roles.includes('admin');
}

export function projectLiveVacancyForActor<T extends { liveVacancy: unknown }>(
  service: T,
  actor: HourlyValueActor,
): T & { liveVacancyRedacted: boolean } {
  if (canReadLiveVacancy(actor)) return { ...service, liveVacancyRedacted: false };
  return { ...service, liveVacancy: null, liveVacancyRedacted: true };
}
