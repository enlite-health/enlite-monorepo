/**
 * VacancyLinkEligibility — regra pura de elegibilidade da vaga para vínculo ao serviço contratado
 * (spec 079, §6). Fonte única: a MESMA função lista as candidatas e re-valida na confirmação,
 * para a lista e o veredito final nunca divergirem.
 *
 * Ordem das checagens (a primeira que falha dá o motivo): DELETED -> OTHER_PATIENT ->
 * ALREADY_LINKED (inclusive se já for deste serviço). Qualquer status é elegível, inclusive DE_BAJA: vincular a vaga
 * baixada a um serviço é o caminho de volta dela (Gabriel, 06/11) — o use case restaura o status ao vincular.
 * `NOT_FOUND` é do use case (a vaga nem existe), não daqui.
 */
import type { VacancyNotLinkableReason } from './LinkExistingVacancyContract';

export interface VacancyForLink {
  patientId: string | null;
  contractedServiceId: string | null;
  deletedAt: Date | string | null;
  status: string | null;
}

export type VacancyLinkEligibility =
  | { eligible: true }
  | { eligible: false; reason: Exclude<VacancyNotLinkableReason, 'NOT_FOUND'> };

export function vacancyLinkEligibility(
  vacancy: VacancyForLink,
  service: { patientId: string },
): VacancyLinkEligibility {
  if (vacancy.deletedAt != null) return { eligible: false, reason: 'DELETED' };
  if (vacancy.patientId !== service.patientId) return { eligible: false, reason: 'OTHER_PATIENT' };
  if (vacancy.contractedServiceId != null) return { eligible: false, reason: 'ALREADY_LINKED' };
  return { eligible: true };
}

/**
 * Candidatas do vínculo entre as vagas VIVAS de um paciente: as que `vacancyLinkEligibility` aprova.
 * Fonte única da lista do preview do vínculo (079) e da trava do foguete (`ActivateRecruitmentUseCase`) —
 * as duas nunca divergem sobre o que é "vaga vinculável". Entrada já sem apagadas (`deleted_at IS NULL` na query).
 */
export function linkableVacancies<T extends { contractedServiceId: string | null; status: string | null }>(
  vacancies: readonly T[],
  patientId: string,
): T[] {
  return vacancies.filter(
    (v) =>
      vacancyLinkEligibility(
        { patientId, contractedServiceId: v.contractedServiceId, deletedAt: null, status: v.status },
        { patientId },
      ).eligible,
  );
}

/**
 * Status de vaga ENCERRADA para o FOGUETE (decisão do Gabriel): vaga antiga encerrada não conta como candidata —
 * se o paciente só tem encerrada, o foguete cria vaga nova direto. NÃO vale para o vínculo manual da 079, onde
 * CLOSED/FILLED/DE_BAJA são elegíveis. DE_BAJA entra aqui para o foguete seguir como antes (baixada não conta como candidata). (`FILLED` não existe no CHECK de `job_postings.status`; fica aqui por decisão.)
 */
export const ROCKET_CLOSED_VACANCY_STATUSES: readonly string[] = ['CLOSED', 'FILLED', 'DE_BAJA'];

/** Candidatas do FOGUETE: as vinculáveis (`linkableVacancies`, sem duplicar a elegibilidade) que NÃO estão encerradas. */
export function linkableOpenVacancies<T extends { contractedServiceId: string | null; status: string | null }>(
  vacancies: readonly T[],
  patientId: string,
): T[] {
  return linkableVacancies(vacancies, patientId).filter(
    (v) => v.status == null || !ROCKET_CLOSED_VACANCY_STATUSES.includes(v.status),
  );
}
