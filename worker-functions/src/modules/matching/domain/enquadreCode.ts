import { generateAdmissionCode } from './admissionCode';

/**
 * Código do evento de enquadre (spec 052): `ENC-XXXXXX`, mesmo alfabeto e mesmo sorteio do `ADM-` da admissão
 * (nenhuma cópia). Vai no título do evento do Calendar; migration 518: CHECK `^ENC-[0-9A-Z]{6}$` + índice único.
 */
export const ENQUADRE_CODE_PREFIX = 'ENC-';

export function generateEnquadreCode(pick?: (maxExclusive: number) => number): string {
  return generateAdmissionCode(pick, ENQUADRE_CODE_PREFIX);
}
