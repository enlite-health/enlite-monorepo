import type { Gender } from '@modules/worker/domain/enums/Gender';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Sexo Prestador" drop-down labels (Admisiones list)
 * to canonical Gender. Despite the field name, the presence of "Trans"
 * indicates this captures gender identity, not biological sex.
 */
export const CLICKUP_TO_GENDER: Record<string, Gender> = {
  'Hombre':            'MALE',        // ClickUp: "Hombre" (Admisiones)
  'Mujer':             'FEMALE',      // ClickUp: "Mujer" (Admisiones)
  'Trans':             'TRANS',       // ClickUp: "Trans" (Admisiones)
  'Prefiero no decir': 'UNDISCLOSED', // ClickUp: "Prefiero no decir" (Admisiones)
};

export function mapClickUpGender(label: string | null): Gender | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_GENDER[label];
  if (mapped === undefined) {
    // Unknown ClickUp label — ops may have added or renamed an option. Log it so it can be mapped.
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Sexo Prestador');
    console.warn('[genderMap] Unknown ClickUp label:', { field: 'Sexo Prestador', label });
    return null;
  }
  return mapped;
}
