import { randomInt } from 'crypto';

/**
 * Código da reunião de admissão (spec 049): `ADM-XXXXXX`, 6 caracteres de `[0-9A-Z]` SEM `0`, `O`, `1`, `I`
 * (não se confundem ao ler em voz alta ou na tela). Vai no título do evento do Calendar e é a chave da importação
 * do Tactiq (migration 503: CHECK `^ADM-[0-9A-Z]{6}$` + índice único).
 * `crypto.randomInt` (CSPRNG), nunca `Math.random`.
 */
export const ADMISSION_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ADMISSION_CODE_PREFIX = 'ADM-';
export const ADMISSION_CODE_LENGTH = 6;

export function generateAdmissionCode(pick: (maxExclusive: number) => number = (max) => randomInt(max)): string {
  let out = '';
  for (let i = 0; i < ADMISSION_CODE_LENGTH; i += 1) out += ADMISSION_CODE_ALPHABET[pick(ADMISSION_CODE_ALPHABET.length)];
  return ADMISSION_CODE_PREFIX + out;
}
