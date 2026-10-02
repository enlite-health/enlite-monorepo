/**
 * src/modules/anacare-hours/application/sanitizeFilenamePart.ts
 *
 * Spec 032 (D7) — pedaço de nome de arquivo ASCII-seguro para o `Content-Disposition` do xlsx.
 * Única dona da regra: o rótulo do paciente (nome ou `Sin vínculo · ID <id>`) passa SEMPRE por aqui.
 *
 * NFD + remove diacríticos → espaço vira `_` → remove tudo fora de `[A-Za-z0-9_]` → colapsa `_`
 * repetidos e apara as pontas → mantém a caixa. Vazio/só símbolos → `SIN_NOMBRE`. O hífen SAI (FR-013):
 * `AC-PAT-0` → `ACPAT0`; ele só existe como separador entre as partes do nome do arquivo.
 */
export const EMPTY_FILENAME_PART = 'SIN_NOMBRE';

export function sanitizeFilenamePart(raw: string): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? EMPTY_FILENAME_PART : cleaned;
}
