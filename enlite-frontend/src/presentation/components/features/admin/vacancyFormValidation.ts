import type { FieldErrors } from 'react-hook-form';
import type { VacancyFormData } from './vacancy-form-schema';

/**
 * Map RHF/Zod field errors to user-friendly labels so the validation banner
 * can list exactly what's missing instead of silently blocking submit.
 *
 * Spec 014 (US-D6, lex D6.1): a lista carrega SÓ o NOME do campo (rótulo i18n) — NUNCA o valor
 * que a pessoa digitou. `errors[key].message` nunca entra aqui, só a CHAVE do campo decide se o
 * rótulo aparece; o texto exibido vem sempre de `tp(...)`, nunca do erro em si.
 */
export function listInvalidFields(
  errors: FieldErrors<VacancyFormData>,
  tp: (k: string) => string,
): string[] {
  const labels: string[] = [];
  if (errors.title) labels.push(tp('caseNumber'));
  if (errors.required_professions) labels.push(tp('professionalType'));
  if (errors.age_range_max) labels.push(tp('ageRange'));
  if (errors.patientAddressId) labels.push(tp('serviceAddress'));
  if (errors.providers_needed) labels.push(tp('providersNeeded'));
  if (errors.schedule) labels.push(tp('schedule'));
  if (errors.meet_links) labels.push(tp('meetLinksLabel'));
  return labels;
}
