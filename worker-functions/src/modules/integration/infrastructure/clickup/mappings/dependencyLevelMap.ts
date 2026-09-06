import type { DependencyLevel } from '@modules/case';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Dependencia" drop-down labels to canonical DependencyLevel.
 * ClickUp returns orderindex; ClickUpFieldResolver.resolveDropdown() returns the LABEL.
 * This map keys on the label (Spanish text from ClickUp).
 */
export const CLICKUP_TO_DEPENDENCY_LEVEL: Record<string, DependencyLevel> = {
  'GRAVE':     'SEVERE',       // ClickUp: "GRAVE" (es)
  'MUY GRAVE': 'VERY_SEVERE',  // ClickUp: "MUY GRAVE" (es)
  'MODERADA':  'MODERATE',     // ClickUp: "MODERADA" (es)
  'LEVE':      'MILD',         // ClickUp: "LEVE" (es)
};

export function mapClickUpDependencyLevel(label: string | null): DependencyLevel | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_DEPENDENCY_LEVEL[label];
  if (mapped === undefined) {
    // CLINICAL field (dato sensible-salud) — C1 do parecer do `lex` de 23/08 is a PARE on the
    // raw value reaching a log. Field name + shape only; the catalog answers "which option" (C2).
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Dependencia');
    console.warn('[dependencyLevelMap] Unmapped ClickUp option (value withheld — C1/lex):', {
      field: 'Dependencia',
      valueType: typeof label,
      isArray: Array.isArray(label),
      length: label.length,
    });
    return null;
  }
  return mapped;
}
