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

/** Mensagem localizada de um erro da API que traz `code` estável (409 do PUT da vaga: R17 e encerrar vaga de serviço ativo). */
export function vacancyUpdateErrorMessage(err: unknown, t: TFunction): string {
  const code = (err as { code?: string } | null)?.code;
  if (code) {
    const key = `admin.vacancyDetail.statusEditor.errors.${code}`;
    const msg = t(key, { defaultValue: '' });
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : String(err);
}
