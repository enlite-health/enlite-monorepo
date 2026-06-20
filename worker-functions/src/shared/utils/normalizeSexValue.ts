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
 * Accepted input variants (production data):
 *   - 'male', 'MALE', 'masculino', 'M', 'm'  → 'male'
 *   - 'female', 'FEMALE', 'femenino', 'femenina', 'F', 'f'  → 'female'
 *   - null / undefined / '' / 'BOTH' / 'OTHER' / anything else  → null
 */
export function normalizeSexValue(
  value: string | null | undefined,
): 'male' | 'female' | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  if (v === 'M' || v === 'MALE' || v === 'MASCULINO') return 'male';
  if (v === 'F' || v === 'FEMALE' || v === 'FEMENINO' || v === 'FEMENINA') return 'female';
  return null;
}
