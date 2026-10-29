/**
 * PatientCompleteness — espelha `worker-functions/src/modules/case/domain/PatientCompleteness.ts`
 * (spec 014 US-D1, lex D1.1/D1.2). A MESMA lista que o backend usa tanto no checklist (`GET /:id`)
 * quanto nos gates de troca de status e de ativação de recrutamento.
 *
 * `DIAGNOSIS` (pedido do Javier) é o único código que nomeia dado clínico, e circula só como
 * EXISTÊNCIA ("falta ≥1 diagnóstico CID-11 ativo"), nunca como valor. Quem não lê `patient_clinical`
 * nunca o recebe: o servidor manda `CLINICAL_DATA` no lugar (mesma pendência, nome genérico).
 */

export const PATIENT_COMPLETENESS_CODES = [
  'ADDRESS',
  'RESPONSIBLE',
  'COVERAGE',
  'CONTRACTED_SERVICE',
  /** Migration 330: há serviço ativo sem endereço vinculado — a vaga não tem de onde nascer. */
  'SERVICE_ADDRESS',
  /**
   * Decisão do Gabriel 07/09: há serviço ativo sem horário. O horário CONTINUA opcional na carga
   * do serviço — o que ele passa a travar é a MUDANÇA DE STATUS para ACTIVE, SEARCHING ou
   * REPLACEMENT.
   */
  'SERVICE_SCHEDULE',
  'CONSENT',
  /**
   * Pedido do Javier: o paciente só ENTRA em atendimento (e só ativa recrutamento) com ≥1 diagnóstico
   * CID-11 ATIVO. Só aparece em `completeness.missing` quando o paciente está num estágio pré-atendimento.
   */
  'DIAGNOSIS',
  /**
   * Código de SAÍDA, nunca calculado: o que o servidor manda no lugar de `DIAGNOSIS` para quem não tem
   * `patient_clinical:read` (a trava vale igual; o nome clínico não vaza). Espelha `CLINICAL_DATA_GENERIC_CODE`.
   */
  'CLINICAL_DATA',
] as const;

export type PatientCompletenessCode = (typeof PATIENT_COMPLETENESS_CODES)[number];

/**
 * D255 (decisão 03/09) — espelha `ACTIVATION_BLOCKING_CODES` do backend
 * (`worker-functions/src/modules/case/domain/PatientCompleteness.ts`). ADDRESS e, desde a
 * migration 330, SERVICE_ADDRESS bloqueiam o `POST /activate` (os dois pela mesma razão: a vaga
 * precisa de endereço); os demais códigos são checklist informativo, não bloqueio.
 */
export const ACTIVATION_BLOCKING_CODES = [
  'ADDRESS',
  'SERVICE_ADDRESS',
  'SERVICE_SCHEDULE',
  // Pedido do Javier: a admissão só "fecha" com ≥1 diagnóstico ativo (só é calculado com o paciente pré-atendimento).
  'DIAGNOSIS',
] as const;

/*
 * NÃO existe aqui um espelho de `SCHEDULE_REQUIRED_STATUSES` (os estados que exigem horário).
 * A 1ª versão deste arquivo tinha um, "para explicar ao operador" — e nenhum componente o lia:
 * a explicação vive nas strings de i18n ("no puede pasar a activo, búsqueda ni reemplazo"), e
 * quem RECUSA é sempre o servidor. Constante espelhada que ninguém lê é a que diverge do backend
 * em silêncio, então ela saiu. Se um dia a UI precisar decidir por esse conjunto, ele volta —
 * com consumidor.
 */

/**
 * Status em que o checklist/botão "Activar paciente" fazem sentido — espelha
 * `ACTIVATABLE_STATUSES` do backend. Fonte ÚNICA no front: `ActivatePatientButton` e
 * `PatientDetailPage` leem esta constante em vez de manter cada um seu próprio `Set`.
 */
export const ACTIVATABLE_STATUSES = ['ADMISSION', 'PENDING_ADMISSION'] as const;

/**
 * Gate de "Activar reclutamiento" (spec 018, PR-6, `contracts/activation.md`) — espelha
 * `RECRUITMENT_BLOCKING_CODES` do backend (`PatientCompleteness.ts`). Avaliado POR SERVIÇO
 * (`SERVICE_ADDRESS`/`SERVICE_SCHEDULE` do serviço em questão, nunca "algum serviço do
 * paciente") + `COVERAGE` do paciente. Só decide o ESTADO do botão na tela — quem decide de
 * verdade é sempre o backend (422 `PATIENT_NOT_READY`).
 */
export const RECRUITMENT_BLOCKING_CODES = [
  'SERVICE_ADDRESS',
  'SERVICE_SCHEDULE',
  // Spec 027 Fase 3 (D508 c): os 5 campos que a vaga copia do serviço — um código POR CAMPO (o tooltip diz qual falta).
  'SERVICE_REQUIRED_PROFESSIONS',
  'SERVICE_REQUIRED_SEX',
  'SERVICE_REQUIRED_EXPERIENCE',
  'SERVICE_WORK_SCHEDULE',
  'SERVICE_PAYMENT_DAY',
  'COVERAGE',
  // Pedido do Javier: ativar recrutamento com o paciente pré-atendimento exige ≥1 diagnóstico ativo.
  'DIAGNOSIS',
] as const;

/**
 * Estágios PRÉ-ATENDIMENTO — espelha `PRE_CARE_STATUSES` do backend. Neles o diagnóstico CID-11 é exigido
 * para ENTRAR em atendimento (SEARCHING, ACTIVE, ON_HOLD, REPLACEMENT, SUSPENDED); andar entre eles é livre.
 */
export const PRE_CARE_STATUSES = ['SOLICITANTE', 'PENDING_ADMISSION', 'ADMISSION'] as const;

/**
 * Qual pendência de diagnóstico a ficha tem, lida do checklist que o SERVIDOR devolveu (a única fonte —
 * o front não conta diagnósticos: quem não lê o container clínico nem recebe a lista). `DIAGNOSIS` para
 * quem lê; `CLINICAL_DATA` para quem não lê; `null` quando nada falta (inclusive fora de ADMISSION).
 */
export function diagnosisGapOf(
  completeness: { missing: readonly string[] } | null | undefined,
): 'DIAGNOSIS' | 'CLINICAL_DATA' | null {
  const missing = completeness?.missing ?? [];
  if (missing.includes('DIAGNOSIS')) return 'DIAGNOSIS';
  if (missing.includes('CLINICAL_DATA')) return 'CLINICAL_DATA';
  return null;
}

/** Os 5 campos do serviço que a vaga copia (D508) — `workerAttributes`/`dailyObs` ficam fora: são só ficha e opcionais. */
export interface ServiceRecruitmentFields {
  requiredProfessions: readonly string[] | null | undefined;
  /** 'M' | 'F' | 'BOTH'. `null`/ausente = FALTANDO (lex S.2); 'BOTH' = respondido (indistinto). */
  requiredSex: string | null | undefined;
  requiredExperience: string | null | undefined;
  workSchedule: string | null | undefined;
  paymentDay: string | null | undefined;
}

const hasText = (v: string | null | undefined): boolean => (v ?? '').trim().length > 0;

/** Códigos POR CAMPO que faltam dos 5 (ordem fixa = a do formulário). Vazio = os 5 preenchidos. */
export function serviceRecruitmentMissingCodes(
  f: ServiceRecruitmentFields | undefined,
): Array<(typeof RECRUITMENT_BLOCKING_CODES)[number]> {
  const missing: Array<(typeof RECRUITMENT_BLOCKING_CODES)[number]> = [];
  if (!(f?.requiredProfessions ?? []).some((p) => hasText(p))) missing.push('SERVICE_REQUIRED_PROFESSIONS');
  if (!hasText(f?.requiredSex)) missing.push('SERVICE_REQUIRED_SEX');
  if (!hasText(f?.requiredExperience)) missing.push('SERVICE_REQUIRED_EXPERIENCE');
  if (!hasText(f?.workSchedule)) missing.push('SERVICE_WORK_SCHEDULE');
  if (!hasText(f?.paymentDay)) missing.push('SERVICE_PAYMENT_DAY');
  return missing;
}

/**
 * FR-121/122 — mesma régua de `isPlaceholderCoverageValue` do backend: "sin cobertura /
 * particular" É uma resposta válida; placeholder (< 2 alfanuméricos, ou só zeros) não é.
 */
export function isPlaceholderCoverageValue(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return true;
  const alphanumeric = trimmed.replace(/[^a-zA-Z0-9À-ÿ]/g, '');
  if (alphanumeric.length < 2) return true;
  return /^0+$/.test(alphanumeric);
}

export interface RecruitmentReadinessInput {
  serviceHasAddress: boolean;
  serviceHasSchedule: boolean;
  insuranceInformed: string | null;
  /**
   * Hotfix gate-cobertura-verificada-vacante (28/09): mesmo campo do backend
   * (`worker-functions/.../PatientCompleteness.ts`) — o paciente tem cobertura verificada com
   * provider ATIVO no catálogo (`patient.hasVerifiedActiveCoverage`). Opcional (default
   * `false`) para não quebrar chamadores existentes que só conheciam o legado. `COVERAGE` é
   * satisfeito pelo legado OU por esta cobertura verificada — nunca os dois exigidos.
   */
  hasVerifiedActiveCoverage?: boolean;
  /** Spec 027 Fase 3: os 5 campos copiados do serviço. Ausente = nenhum preenchido (faltando). */
  serviceRecruitmentFields?: ServiceRecruitmentFields;
  /** Pendência de diagnóstico da ficha (`diagnosisGapOf(patient.completeness)`); ausente = nada falta. */
  diagnosisGap?: 'DIAGNOSIS' | 'CLINICAL_DATA' | null;
}

/** Códigos que faltam para ESTE serviço poder ativar recrutamento — vazio = pronto. */
export function recruitmentMissingCodes(
  input: RecruitmentReadinessInput,
): Array<(typeof RECRUITMENT_BLOCKING_CODES)[number] | 'CLINICAL_DATA'> {
  const missing: Array<(typeof RECRUITMENT_BLOCKING_CODES)[number] | 'CLINICAL_DATA'> = [];
  if (!input.serviceHasAddress) missing.push('SERVICE_ADDRESS');
  if (!input.serviceHasSchedule) missing.push('SERVICE_SCHEDULE');
  missing.push(...serviceRecruitmentMissingCodes(input.serviceRecruitmentFields));
  if (isPlaceholderCoverageValue(input.insuranceInformed) && !input.hasVerifiedActiveCoverage) {
    missing.push('COVERAGE');
  }
  if (input.diagnosisGap) missing.push(input.diagnosisGap);
  return missing;
}

export interface PatientCompleteness {
  missing: PatientCompletenessCode[];
  /** missing ∩ ACTIVATION_BLOCKING_CODES (D255) — os códigos que REALMENTE bloqueiam o activate. */
  blocking: PatientCompletenessCode[];
  ready: boolean;
  /** blocking.length === 0. */
  canActivate: boolean;
}
