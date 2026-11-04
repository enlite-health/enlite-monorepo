/**
 * LegacyVacancyCutoff — a LINHA DE CORTE da spec 084 (F3), regra PURA: dado os fatos de uma vaga viva, em que grupo ela cai.
 * Só entra vaga viva, SEM serviço (`contracted_service_id IS NULL`) e fora de DE_BAJA; o grupo `e` olha vaga COM serviço.
 *
 *  a  aberta, paciente deu baixa (DISCHARGED/ALTA) ou foi apagado           → BAIXAR
 *  b  aberta, paciente ativo SEM serviço nenhum cadastrado (R5)             → BAIXAR
 *  c  aberta, paciente ativo com serviço ATIVO                              → MERGE na vaga do serviço + BAIXAR (R19), só com destino no mapa
 *  x  aberta, sem paciente ligado (R15)                                     → BAIXAR
 *  d  não aberta (R15): encerrada → BAIXAR; suspensa/Activo/En espera de paciente com baixa → BAIXAR;
 *     suspensa/Activo/En espera de paciente ativo → LISTA DE REVISÃO (não baixa)
 *  e  vaga de serviço ATIVO hoje encerrada (CLOSED) → "En espera" (R4/R18)
 *  revisão: o que não cabe em nenhuma regra acima (rascunho sem serviço, paciente só com serviço inativo, suspensa sem paciente…)
 *           NUNCA é baixado por chute: vai para a lista de revisão com o motivo.
 *
 * "Aberta" = a regra única de vaga viva (SUP-3): não rascunho e status em OPEN_JOB_STATUSES.
 */
import { OPEN_JOB_STATUSES_SET } from '../../matching/domain/openJobStatuses';

export type CutoffGroup = 'a' | 'b' | 'c' | 'x' | 'd-baixar' | 'e' | 'revisao';

export type ReviewReason =
  | 'NAO_ABERTA_PACIENTE_ATIVO'     // R15: 22 suspensas + 8 "Activo" de paciente ativo
  | 'RASCUNHO_SEM_SERVICO'
  | 'PACIENTE_SO_SERVICO_INATIVO'
  | 'NAO_ABERTA_SEM_PACIENTE_FORA_DA_REGRA'
  | 'FORA_DAS_REGRAS';

export interface LegacyVacancyFacts {
  status: string;
  isDraft: boolean;
  hasPatientId: boolean;
  /** Paciente existe (não apagado). Só faz sentido com `hasPatientId`. */
  patientExists: boolean;
  /** `patients.status` (null se o paciente não existe). */
  patientStatus: string | null;
  patientServiceCount: number;
  patientActiveServiceCount: number;
}

export interface CutoffDecision {
  group: CutoffGroup;
  reviewReason?: ReviewReason;
}

/** Paciente que "deu baixa" (SUP-1): estado DISCHARGED ("Baja") ou ALTA, ou paciente apagado. */
export function patientIsGone(f: Pick<LegacyVacancyFacts, 'hasPatientId' | 'patientExists' | 'patientStatus'>): boolean {
  if (!f.hasPatientId) return false;
  return !f.patientExists || f.patientStatus === 'DISCHARGED' || f.patientStatus === 'ALTA';
}

export const isOpenVacancy = (f: Pick<LegacyVacancyFacts, 'status' | 'isDraft'>): boolean =>
  !f.isDraft && OPEN_JOB_STATUSES_SET.has(f.status);

/** Classifica uma vaga viva SEM serviço e fora de DE_BAJA. */
export function classifyLegacyVacancy(f: LegacyVacancyFacts): CutoffDecision {
  if (f.isDraft) return { group: 'revisao', reviewReason: 'RASCUNHO_SEM_SERVICO' };

  if (isOpenVacancy(f)) {
    if (!f.hasPatientId) return { group: 'x' };
    if (patientIsGone(f)) return { group: 'a' };
    if (f.patientServiceCount === 0) return { group: 'b' };
    if (f.patientActiveServiceCount > 0) return { group: 'c' };
    return { group: 'revisao', reviewReason: 'PACIENTE_SO_SERVICO_INATIVO' };
  }

  // Não aberta (grupo d).
  if (f.status === 'CLOSED') return { group: 'd-baixar' };
  if (['SUSPENDED', 'ACTIVE', 'ON_HOLD'].includes(f.status)) {
    if (!f.hasPatientId) return { group: 'revisao', reviewReason: 'NAO_ABERTA_SEM_PACIENTE_FORA_DA_REGRA' };
    return patientIsGone(f) ? { group: 'd-baixar' } : { group: 'revisao', reviewReason: 'NAO_ABERTA_PACIENTE_ATIVO' };
  }
  return { group: 'revisao', reviewReason: 'FORA_DAS_REGRAS' };
}

/** Grupo e: vaga de serviço ATIVO hoje CLOSED → ON_HOLD. SUSPENDED fica como está (SUP-2). */
export function isGroupE(f: { status: string; serviceActive: boolean | null }): boolean {
  return f.status === 'CLOSED' && f.serviceActive === true;
}

export const BAIXAR_GROUPS: readonly CutoffGroup[] = ['a', 'b', 'x', 'd-baixar'];
