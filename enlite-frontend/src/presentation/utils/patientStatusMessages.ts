/**
 * Spec 051 (§6.4) — a frase que o operador lê quando a troca de estado do paciente é recusada,
 * a MESMA na ficha e no Kanban. A frase principal nunca carrega código técnico, enum nem nome de
 * célula: o `code`/`details` (inclusive `details.cell`) ficam no corpo da resposta, para o suporte.
 *
 * Devolve `null` para código que esta função não conhece — o chamador cai no seu próprio genérico.
 * O estado de destino e a lista "Falta: …" são traduzidos aqui, com as chaves que a tela já usa
 * (`admin.patients.statusOptions.*` e `admin.patients.detail.completeness.items.*`).
 */
import { STATUS_NOT_OFFERED, STATUS_OPTIONS_UNAVAILABLE } from '@domain/entities/PatientLifecycle';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Recusa de troca de estado, como a tela a recebe (do servidor ou da lista local). */
export interface StatusRefusal {
  /** `PatientApiError.code`, ou `STATUS_NOT_OFFERED` quando a tela nem chegou a chamar o PUT. */
  code?: string;
  /** Estado de destino que o operador pediu. */
  to?: string;
  /** `details.missing` do 422 de completude. */
  missing?: string[];
}

/** "Horario del servicio" → "horario del servicio" (só a 1ª letra, e só se a 2ª não for maiúscula: CID, AT…). */
function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Códigos de completude → "a, b" com as chaves do checklist da ficha. */
export function missingItemsLabel(t: Translate, missing: readonly string[] | undefined): string {
  return (Array.isArray(missing) ? missing : [])
    .map((code) => lowerFirst(t(`admin.patients.detail.completeness.items.${code}`, { defaultValue: code })))
    .join(', ');
}

export function friendlyStatusMessage(t: Translate, r: StatusRefusal): string | null {
  const f = (k: string, o?: Record<string, unknown>): string => t(`admin.patients.status.friendly.${k}`, o);
  const status = r.to ? t(`admin.patients.statusOptions.${r.to}`, { defaultValue: r.to }) : '';
  switch (r.code) {
    case 'PATIENT_STATUS_MOVE_NOT_PERMITTED':
      return f('forbidden', { status });
    case 'PATIENT_STATUS_NOT_READY': {
      const items = missingItemsLabel(t, r.missing);
      // Sem lista, "Falta: ." sairia vazio — a frase genérica é a honesta (achado do gate, 07/09).
      if (!items) return f('notReadyGeneric', { status });
      return r.to === 'SEARCHING' ? f('notReadySearching', { status, items }) : f('notReady', { status, items });
    }
    case 'ON_HOLD_REASON_REQUIRED':
      return f('onHoldReasonRequired');
    case 'SUSPENSION_EXIT_REASON_REQUIRED':
      return f('suspensionExitReasonRequired');
    case 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED':
    case STATUS_NOT_OFFERED:
      return f('notAvailable');
    case STATUS_OPTIONS_UNAVAILABLE:
      return f('optionsUnavailable');
    default:
      return null;
  }
}
