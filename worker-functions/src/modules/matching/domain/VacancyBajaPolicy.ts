/**
 * VacancyBajaPolicy — regras puras da spec 084 sobre dar baixa (DE_BAJA) e pausar vaga. Sem I/O.
 *
 *  - P1: baixa à mão SÓ em vaga SEM serviço. Vaga de serviço ativo não baixa nem encerra: pausa (ON_HOLD, R4/R18).
 *    Vaga de serviço inativo já é baixada sozinha pelo gatilho do serviço.
 *  - P2: todo DE_BAJA guarda o motivo: MANUAL (à mão) · CUTOFF (linha de corte) · SERVICE (o serviço deu baixa).
 *  - R17 (REGRA DURA): nenhuma vaga sai de DE_BAJA por ação de usuário. A ÚNICA volta é a reativação do serviço,
 *    e só devolve as de motivo SERVICE.
 */

export const BAJA_REASONS = ['MANUAL', 'CUTOFF', 'SERVICE'] as const;
export type BajaReason = (typeof BAJA_REASONS)[number];

export const DE_BAJA_STATUS = 'DE_BAJA';

export interface VacancyBajaFacts {
  status: string | null;
  /** `job_postings.contracted_service_id`: a vaga nasceu de um serviço. */
  contractedServiceId: string | null;
}

export type BajaRefusalCode = 'VACANCY_HAS_SERVICE' | 'VACANCY_ALREADY_DE_BAJA';

export type BajaDecision = { ok: true } | { ok: false; code: BajaRefusalCode };

/** P1: só vaga sem serviço, ainda não baixada. */
export function decideManualBaja(v: VacancyBajaFacts): BajaDecision {
  if (v.status === DE_BAJA_STATUS) return { ok: false, code: 'VACANCY_ALREADY_DE_BAJA' };
  if (v.contractedServiceId !== null) return { ok: false, code: 'VACANCY_HAS_SERVICE' };
  return { ok: true };
}

/** Mensagens es + pt-BR dos recusos (a API devolve as duas; a tela escolhe pelo idioma). */
export const BAJA_REFUSAL_MESSAGES: Record<BajaRefusalCode | 'VACANCY_DE_BAJA_NO_REACTIVATION' | 'CLOSE_ACTIVE_SERVICE_VACANCY_REFUSED', { es: string; 'pt-BR': string }> = {
  VACANCY_HAS_SERVICE: {
    es: 'Una vacante de un servicio contratado no se da de baja a mano: usá "Pausar" (En espera).',
    'pt-BR': 'Vaga de serviço contratado não recebe baixa manual: use "Pausar" (Em espera).',
  },
  VACANCY_ALREADY_DE_BAJA: {
    es: 'La vacante ya está dada de baja.',
    'pt-BR': 'A vaga já está dada de baixa.',
  },
  VACANCY_DE_BAJA_NO_REACTIVATION: {
    es: 'Una vacante dada de baja no se reactiva: solo vuelve cuando se reactiva el servicio que la dio de baja. La vacante nueva nace del botón de reclutamiento del servicio.',
    'pt-BR': 'Vaga dada de baixa não é reativada: só volta quando o serviço que a baixou é reativado. A vaga nova nasce do botão de recrutamento do serviço.',
  },
  CLOSE_ACTIVE_SERVICE_VACANCY_REFUSED: {
    es: 'Una vacante de un servicio activo no se cierra: usá "Pausar" (En espera).',
    'pt-BR': 'Vaga de serviço ativo não é encerrada: use "Pausar" (Em espera).',
  },
};

/** R4/P1: encerrar (CLOSED) vaga ligada a serviço ATIVO é recusado — pausa (ON_HOLD). */
export function refusesCloseOfActiveServiceVacancy(
  nextStatus: unknown,
  v: { contractedServiceId: string | null; serviceActive: boolean | null },
): boolean {
  return nextStatus === 'CLOSED' && v.contractedServiceId !== null && v.serviceActive === true;
}
