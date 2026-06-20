/**
 * normalizeSexValue
 *
 * Canonical normalizer for the sex field used as the WRITE + READ + BACKFILL
 * canonical value for sex_bidx.
 *
 * ALL three paths (write-path in WorkerPersonalInfoRepository,
 * write-path in WorkerImportRepository, backfill script, and the list
 * filter in AdminWorkersController) MUST use this function so that
 * HMAC(normalizeSexValue(x)) is always identical regardless of the source.
 *
 * Canonical output: 'male' | 'female' | null (lowercase English)
 *
 * Accepted input variants (production data — inclui espanhol AR real):
 *   - 'male', 'MALE', 'masculino', 'M', 'hombre', 'varón', 'varon'  → 'male'
 *   - 'female', 'FEMALE', 'femenino', 'femenina', 'F', 'mujer'  → 'female'
 *   - null / undefined / '' / 'Trans' / 'BOTH' / 'OTHER' / anything else  → null
 *
 * Acentos são removidos antes do match (VARÓN === VARON). O filtro de sexo é
 * binário (male/female); valores não-binários (ex: 'Trans') retornam null e
 * ficam fora do filtro por design.
 */
export function normalizeSexValue(
  value: string | null | undefined,
): 'male' | 'female' | null {
  if (!value) return null;
  // trim + uppercase + remove acentos (NFD) para casar VARÓN/varon, etc.
  const v = value
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(new RegExp('[\u0300-\u036f]', 'g'), '');
  if (v === 'M' || v === 'MALE' || v === 'MASCULINO' || v === 'HOMBRE' || v === 'VARON') {
    return 'male';
  }
  if (v === 'F' || v === 'FEMALE' || v === 'FEMENINO' || v === 'FEMENINA' || v === 'MUJER') {
    return 'female';
  }
  return null;
}
