/**
 * normalizeSexValue
 *
 * SSOT de normalização de sexo BINÁRIO de worker (filtro + matching + write-path
 * + backfill). Saída canônica em UPPERCASE inglês, consistente com o resto do
 * codebase (Gender, case/domain/enums/Sex usam 'MALE'/'FEMALE').
 *
 * Usado por: WorkerPersonalInfoRepository e WorkerImportRepository (write-path),
 * scripts/backfill-sex-languages-bidx (backfill), AdminWorkersListHelpers
 * (filtro), e MatchmakingService.normalizeSexCode (deriva 'M'/'F'). Todos
 * dependem de HMAC(normalizeSexValue(x)) ser idêntico — a saída NÃO pode mudar
 * sem re-backfill de sex_bidx.
 *
 * Canonical output: 'MALE' | 'FEMALE' | null
 *
 * Variantes aceitas (dado real de prod, EN + ES + acentos):
 *   - 'MALE','male','M','masculino','hombre','varón','varon'        → 'MALE'
 *   - 'FEMALE','female','F','femenino','femenina','mujer'           → 'FEMALE'
 *   - null/undefined/''/'Trans'/'Intersex'/'BOTH'/qualquer outro    → null
 *
 * Binário por design (filtro de sexo é male/female). Identidade de gênero
 * (Trans) e sexo de paciente (Intersex/Undisclosed) são vocabulários SEPARADOS
 * — ver @modules/worker/domain/enums/Gender e @modules/case Sex; não confundir.
 */
export function normalizeSexValue(
  value: string | null | undefined,
): 'MALE' | 'FEMALE' | null {
  if (!value) return null;
  // trim + uppercase + remove acentos (NFD) para casar VARÓN/varon, etc.
  const v = value
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
  if (v === 'M' || v === 'MALE' || v === 'MASCULINO' || v === 'HOMBRE' || v === 'VARON') {
    return 'MALE';
  }
  if (v === 'F' || v === 'FEMALE' || v === 'FEMENINO' || v === 'FEMENINA' || v === 'MUJER') {
    return 'FEMALE';
  }
  return null;
}
