import type { Sex } from '@modules/case';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp sex drop-down labels to canonical Sex.
 * Covers the "Estado de Pacientes" list only (Femenino/Masculino/Intersex).
 * The "Admisiones" list uses a separate "Sexo Prestador" field that captures
 * gender identity — see genderMap.ts for that mapping.
 */
export const CLICKUP_TO_SEX: Record<string, Sex> = {
  // Estado de Pacientes list labels
  'Femenino':          'FEMALE',      // ClickUp: "Femenino" (es)
  'Masculino':         'MALE',        // ClickUp: "Masculino" (es)
  'Intersex':          'INTERSEX',    // ClickUp: "Intersex"
  'Prefiero no decir': 'UNDISCLOSED', // ClickUp: "Prefiero no decir" (es)
};

export function mapClickUpSex(label: string | null): Sex | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_SEX[label];
  if (mapped === undefined) {
    // CLINICAL field (dato sensible-salud) — C1 do parecer do `lex` de 23/08 is a PARE on the
    // raw value reaching a log. Field name + shape only; the catalog answers "which option" (C2).
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Sexo Asignado al Nacer (Uso Clínico)');
    console.warn('[sexMap] Unmapped ClickUp option (value withheld — C1/lex):', {
      field: 'Sexo Asignado al Nacer (Uso Clínico)',
      valueType: typeof label,
      isArray: Array.isArray(label),
      length: label.length,
    });
    return null;
  }
  return mapped;
}
