import type { Profession } from '@modules/worker';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Servicio" drop-down labels to canonical Profession[].
 *
 * "AT y Cuidador" is a composite selection → array of 2 professions.
 * Maps to the same vocabulary as workers.profession (migration 064).
 */
export const CLICKUP_TO_SERVICE_TYPES: Record<string, Profession[]> = {
  'Acompañante Terapéutico': ['AT'],                    // ClickUp: "Acompañante Terapéutico" (es)
  'Cuidador (a)':            ['CAREGIVER'],              // ClickUp: "Cuidador (a)" (es)
  'AT y Cuidador':           ['AT', 'CAREGIVER'],        // ClickUp: "AT y Cuidador" (es) — composite
  'Psicólogo (a)':           ['PSYCHOLOGIST'],           // ClickUp: "Psicólogo (a)" (es)
};

export function mapClickUpService(label: string | null): Profession[] {
  if (!label) return [];
  const mapped = CLICKUP_TO_SERVICE_TYPES[label];
  if (mapped === undefined) {
    // CLINICAL field (dato sensible-salud, per the parecer's field table) — C1 do parecer do
    // `lex` de 23/08 is a PARE on the raw value reaching a log. Field name + shape only;
    // the catalog answers "which option" (C2).
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Servicio');
    console.warn('[serviceMap] Unmapped ClickUp option (value withheld — C1/lex):', {
      field: 'Servicio',
      valueType: typeof label,
      isArray: Array.isArray(label),
      length: label.length,
    });
    return [];
  }
  return mapped;
}
