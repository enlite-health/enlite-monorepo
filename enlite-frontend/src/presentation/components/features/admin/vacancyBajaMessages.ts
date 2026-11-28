import type { TFunction } from 'i18next';
import { VacancyBajaRefusedError } from '@infrastructure/http/AdminVacancyListApiService';

/** Mensagem localizada do erro de baixa: recusa do lote (por código, em es + pt-BR) ou falha genérica. */
export function bajaErrorMessage(err: unknown, t: TFunction, namespace: 'admin.vacancies.baja' | 'admin.vacancyDetail.baja'): string {
  if (err instanceof VacancyBajaRefusedError && err.refused.length > 0) {
    const codes = [...new Set(err.refused.map((r) => r.code))];
    return codes
      .map((code) => t(`admin.vacancies.baja.errors.${code}`, { defaultValue: t(`${namespace}.error`) }))
      .join(' ');
  }
  return t(`${namespace}.error`);
}
