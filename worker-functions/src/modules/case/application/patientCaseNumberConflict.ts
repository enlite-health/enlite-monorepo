/**
 * O 23505 que é CONFLITO DE NÚMERO DE CASO — e só ele.
 *
 * Lido pela constraint, nunca por "todo 23505 é duplicado": é a mesma régua da `C6` do
 * `InsuranceProviderRepository`. Mora sozinho porque os DOIS caminhos de escrita o consultam —
 * o espelho do ClickUp (`PatientService`) e a criação nativa (`PatientNativeCreator`).
 */
export function isCaseNumberConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'patients_case_number_active_unique';
}
