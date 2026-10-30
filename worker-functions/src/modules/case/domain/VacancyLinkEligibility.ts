/**
 * VacancyLinkEligibility — regra pura de elegibilidade da vaga para vínculo ao serviço contratado
 * (spec 079, §6). Fonte única: a MESMA função lista as candidatas e re-valida na confirmação,
 * para a lista e o veredito final nunca divergirem.
 *
 * Ordem das checagens (a primeira que falha dá o motivo): DELETED -> OTHER_PATIENT ->
 * ALREADY_LINKED (inclusive se já for deste serviço) -> DE_BAJA. Qualquer outro status
 * (CLOSED, FILLED, SEARCHING, rascunho, null) é elegível: a spec só exclui DE_BAJA.
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
  if (vacancy.status === 'DE_BAJA') return { eligible: false, reason: 'DE_BAJA' };
  return { eligible: true };
}
