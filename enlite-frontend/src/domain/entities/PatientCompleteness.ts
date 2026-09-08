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

export interface PatientCompleteness {
  missing: PatientCompletenessCode[];
  /** missing ∩ ACTIVATION_BLOCKING_CODES (D255) — os códigos que REALMENTE bloqueiam o activate. */
  blocking: PatientCompletenessCode[];
  ready: boolean;
  /** blocking.length === 0. */
  canActivate: boolean;
}
