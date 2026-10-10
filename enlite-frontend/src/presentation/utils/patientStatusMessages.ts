/**
 * Spec 051 (§6.4) — a frase que o operador lê quando a troca de estado do paciente é recusada,
 * a MESMA na ficha e no Kanban. A frase principal nunca carrega código técnico, enum nem nome de
 * célula: o `code`/`details` (inclusive `details.cell`) ficam no corpo da resposta, para o suporte.
 *
 * Devolve `null` para código que esta função não conhece — o chamador cai no seu próprio genérico.
 * O estado de destino e a lista "Falta: …" são traduzidos aqui, com as chaves que a tela já usa
 * (`admin.patients.statusOptions.*` e `admin.patients.detail.completeness.items.*`).
 */
import { STATUS_NOT_OFFERED, STATUS_OPTIONS_UNAVAILABLE, SERVER_STATUS_REFUSAL as CODE, type StatusRefusal } from '@domain/entities/PatientStatusRefusal';
import type { PatientCompletenessCode } from '@domain/entities/PatientCompleteness';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** "Horario del servicio" → "horario del servicio" (só a 1ª letra, e só se a 2ª não for maiúscula: CID, AT…). */
function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Códigos de completude → "a, b" com as chaves do checklist da ficha. */
export function missingItemsLabel(t: Translate, missing: readonly PatientCompletenessCode[] | undefined): string {
  return (Array.isArray(missing) ? missing : [])
    .map((code) => lowerFirst(t(`admin.patients.detail.completeness.items.${code}`, { defaultValue: code })))
    .join(', ');
}

export function friendlyStatusMessage(t: Translate, r: StatusRefusal): string | null {
  const f = (k: string, o?: Record<string, unknown>): string => t(`admin.patients.status.friendly.${k}`, o);
  const status = r.to ? t(`admin.patients.statusOptions.${r.to}`, { defaultValue: r.to }) : '';
  switch (r.code) {
    case CODE.NOT_PERMITTED:
      return f('forbidden', { status });
    case CODE.NOT_READY: {
      const items = missingItemsLabel(t, r.missing);
      // Sem lista, "Falta: ." sairia vazio — a frase genérica é a honesta (achado do gate, 07/09).
      if (!items) return f('notReadyGeneric', { status });
      return r.to === 'SEARCHING' ? f('notReadySearching', { status, items }) : f('notReady', { status, items });
    }
    case CODE.ON_HOLD_REASON_REQUIRED:
      return f('onHoldReasonRequired');
    case CODE.SUSPENSION_EXIT_REASON_REQUIRED:
      return f('suspensionExitReasonRequired');
    case CODE.TRANSITION_NOT_ALLOWED:
    case STATUS_NOT_OFFERED:
      return f('notAvailable');
    case STATUS_OPTIONS_UNAVAILABLE:
      return f('optionsUnavailable');
    default:
      return null;
  }
}
