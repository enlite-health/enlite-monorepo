import type { Relationship } from '@modules/case';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Relación con el Paciente" drop-down labels to canonical Relationship.
 */
export const CLICKUP_TO_RELATIONSHIP: Record<string, Relationship> = {
  'Hijo / Hija':   'CHILD',      // ClickUp: "Hijo / Hija" (es)
  'Madre / Padre': 'PARENT',     // ClickUp: "Madre / Padre" (es)
  'Hermano/a':     'SIBLING',    // ClickUp: "Hermano/a" (es)
  'Sobrino/a':     'NEPHEW',     // ClickUp: "Sobrino/a" (es)
  'Nieto/a':       'GRANDCHILD', // ClickUp: "Nieto/a" (es)
  'Tutor/a':       'GUARDIAN',   // ClickUp: "Tutor/a" (es)
  'Amigo/a':       'FRIEND',     // ClickUp: "Amigo/a" (es)
  'Pareja':        'PARTNER',    // ClickUp: "Pareja" (es)
  'Otro':          'OTHER',      // ClickUp: "Otro" (es)
};

export function mapClickUpRelationship(label: string | null): Relationship | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_RELATIONSHIP[label];
  if (mapped === undefined) {
    // Unknown ClickUp label — ops may have added or renamed an option. Log it so it can be mapped.
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Relación con el Paciente');
    console.warn('[relationshipMap] Unknown ClickUp label:', { field: 'Relación con el Paciente', label });
    return null;
  }
  return mapped;
}
