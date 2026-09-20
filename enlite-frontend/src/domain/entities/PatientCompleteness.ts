/**
 * PatientCompleteness — espelha `worker-functions/src/modules/case/domain/PatientCompleteness.ts`
 * (spec 014 US-D1, lex D1.1/D1.2). Códigos administrativos, sem item clínico — a MESMA lista que
 * o backend usa tanto no checklist (`GET /:id`) quanto no gate de `POST /activate`.
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
export const RECRUITMENT_BLOCKING_CODES = ['SERVICE_ADDRESS', 'SERVICE_SCHEDULE', 'COVERAGE'] as const;

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
}

/** Códigos que faltam para ESTE serviço poder ativar recrutamento — vazio = pronto. */
export function recruitmentMissingCodes(
  input: RecruitmentReadinessInput,
): Array<(typeof RECRUITMENT_BLOCKING_CODES)[number]> {
  const missing: Array<(typeof RECRUITMENT_BLOCKING_CODES)[number]> = [];
  if (!input.serviceHasAddress) missing.push('SERVICE_ADDRESS');
  if (!input.serviceHasSchedule) missing.push('SERVICE_SCHEDULE');
  if (isPlaceholderCoverageValue(input.insuranceInformed)) missing.push('COVERAGE');
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
