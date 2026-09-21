const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida se uma string é uma data de nascimento ISO (YYYY-MM-DD) real, com
 * calendário válido e não-futura.
 *
 * Defeito 1 (21/09/2026, autorizado pelo Gabriel): `WorkerGeneralInfoBody.birthDate`
 * no openapi era `z.string().optional()` — só documentação, a rota
 * `PUT /api/workers/me/general-info` (SavePersonalInfoUseCase.execute) não validava
 * nada em runtime. Qualquer string era encriptada e gravada em `birth_date_encrypted`.
 */
export function isValidIsoBirthDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;

  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1900) return false;

  // Round-trip em UTC: pega mês/dia que "transbordam" (ex.: 1985-02-30 vira 1985-03-02).
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }

  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() > todayUTC) return false;

  return true;
}
