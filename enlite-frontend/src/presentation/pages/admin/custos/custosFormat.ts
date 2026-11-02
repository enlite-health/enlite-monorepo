/** Formatação do painel de custos (spec 082): dinheiro na moeda da RESPOSTA, variação %, atraso do export. */

import { formatInstant } from '@presentation/utils/dateTimeFormat';
import { localeForLanguage } from '@presentation/components/features/admin/VacancyDetail/draftVacancyFormat';

const HORAS_ATRASO = 36;

/** Valor na `currency` da resposta; sem moeda (estado vazio) cai para número puro. */
export function formatMoney(value: number, currency: string | null, language: string | undefined): string {
  const loc = localeForLanguage(language);
  if (!currency) return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(value);
  return new Intl.NumberFormat(loc, { style: 'currency', currency }).format(value);
}

/** (atual − base) / base em %, com sinal. `null` quando não há base (ausente ou zero): a tela mostra "—". */
export function formatVariation(current: number, base: number | null, language: string | undefined): string | null {
  if (base === null || base === 0) return null;
  const pct = ((current - base) / base) * 100;
  const txt = new Intl.NumberFormat(localeForLanguage(language), { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(pct);
  return `${txt}%`;
}

export function isExportStale(dataUntil: string | null, now: number = Date.now()): boolean {
  if (!dataUntil) return false;
  const ts = Date.parse(dataUntil);
  return Number.isFinite(ts) && now - ts > HORAS_ATRASO * 3_600_000;
}

/** Instante no fuso do operador, 24h (via `formatInstant`); ISO inválido cai para o texto cru. */
export function formatDateTime(iso: string, language: string | undefined): string {
  return (
    formatInstant(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }, localeForLanguage(language)) ?? iso
  );
}
