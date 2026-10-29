// Gabarito (D558/D560): aplicar copia os horários para as faixas; a faixa não guarda referência (spec 074 §5.1).
// Catálogo global de guardias predefinidas (migration 550) — fora de `THERAPEUTIC_CATALOG_KINDS`.
export const SERVICE_SHIFT_TEMPLATE_KIND = 'service-shift-templates' as const;
export const SHIFT_TEMPLATE_MAX_ITEMS = 24;

export interface ShiftTemplateItem { startTime: string; durationMinutes: number } // startTime 'HH:MM'
export interface ShiftTemplate { id: string; code: string; label: string; active: boolean; items: ShiftTemplateItem[] }

/** 422 — dois turnos da mesma guardia se sobrepõem no dia circular de 24 h (constraint `ssti_sem_sobreposicao`). */
export class ShiftTemplateItemsOverlapError extends Error {
  readonly code = 'SHIFT_TEMPLATE_ITEMS_OVERLAP';
  constructor() {
    super('SHIFT_TEMPLATE_ITEMS_OVERLAP');
    this.name = 'ShiftTemplateItemsOverlapError';
  }
}
