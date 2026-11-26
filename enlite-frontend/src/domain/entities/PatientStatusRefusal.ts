/**
 * Spec 051 — como a tela vê a RECUSA de uma troca de estado do paciente. Um só lugar: a ficha e o
 * Kanban leem a mesma forma e o mesmo vocabulário de códigos (a frase amigável sai de
 * `presentation/utils/patientStatusMessages.ts`).
 */
import { type PatientStatus, isPatientStatus } from './patientEnums';
import { PATIENT_COMPLETENESS_CODES, type PatientCompletenessCode } from './PatientCompleteness';

/** `code` que o SERVIDOR manda (403/422 de PUT /patients/:id/status). */
export const SERVER_STATUS_REFUSAL = {
  NOT_PERMITTED: 'PATIENT_STATUS_MOVE_NOT_PERMITTED',
  NOT_READY: 'PATIENT_STATUS_NOT_READY',
  ON_HOLD_REASON_REQUIRED: 'ON_HOLD_REASON_REQUIRED',
  SUSPENSION_EXIT_REASON_REQUIRED: 'SUSPENSION_EXIT_REASON_REQUIRED',
  TRANSITION_NOT_ALLOWED: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED',
  LOCKED_BY_ALLOCATION: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION',
  /** F3: a ação não existe para o estado atual (retomar fora de En espera/Suspendido, reativar fora de Baja). */
  ACTION_NOT_AVAILABLE: 'PATIENT_STATUS_ACTION_NOT_AVAILABLE',
  /** F5: o estado pedido é do fluxo automático (Búsqueda, Reemplazo, Activo) — ninguém o escolhe. */
  NOT_MANUAL: 'PATIENT_STATUS_NOT_MANUAL',
} as const;

/** `blockedBy` de uma ação quando há alocação viva no itinerário (D489/D530). */
export const ACTIVE_ALLOCATION_BLOCK = 'ACTIVE_ALLOCATION';

/** Recusa de troca de estado, como a tela a recebe (do servidor). */
export interface StatusRefusal {
  code?: string;
  /** Estado de destino que o operador pediu. */
  to?: PatientStatus;
  /** `details.missing` do 422 de completude (só códigos conhecidos do checklist). */
  missing?: PatientCompletenessCode[];
}

/** Lê `code` e `details` de um erro de API (estrutural) sem confiar no formato do corpo. */
export function refusalFromError(
  err: { code?: string; details?: unknown },
  fallbackTo: PatientStatus | string | undefined,
): StatusRefusal {
  const d = (typeof err.details === 'object' && err.details !== null ? err.details : {}) as Record<string, unknown>;
  const to = [d.to, fallbackTo].find(isPatientStatus);
  const missing = Array.isArray(d.missing)
    ? d.missing.filter((c): c is PatientCompletenessCode => (PATIENT_COMPLETENESS_CODES as readonly unknown[]).includes(c))
    : undefined;
  return { code: err.code, to, missing };
}
