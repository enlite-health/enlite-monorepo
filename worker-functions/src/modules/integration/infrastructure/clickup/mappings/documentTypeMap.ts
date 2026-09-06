import type { DocumentType } from '@modules/case';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Tipo de Documento Paciente" drop-down labels to canonical DocumentType.
 * Note: ClickUp has a typo "Passaporte" (should be "Pasaporte" in Spanish) — preserved as-is.
 */
export const CLICKUP_TO_DOCUMENT_TYPE: Record<string, DocumentType> = {
  'DNI':        'DNI',       // ClickUp: "DNI"
  'Passaporte': 'PASSPORT',  // ClickUp: "Passaporte" (typo — should be "Pasaporte" in ES)
  'Cédula':     'CEDULA',    // ClickUp: "Cédula" (es)
  'LE/LC':      'LE_LC',     // ClickUp: "LE/LC"
  'CPF':        'CPF',       // ClickUp: "CPF"
};

export function mapClickUpDocumentType(label: string | null): DocumentType | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_DOCUMENT_TYPE[label];
  if (mapped === undefined) {
    // Unknown ClickUp label — ops may have added or renamed an option. Log it so it can be mapped.
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Tipo de Documento Paciente');
    console.warn('[documentTypeMap] Unknown ClickUp label:', { field: 'Tipo de Documento Paciente', label });
    return null;
  }
  return mapped;
}
