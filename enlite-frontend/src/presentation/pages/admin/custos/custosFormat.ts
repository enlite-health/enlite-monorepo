/** Formatação do painel de custos (spec 082): dinheiro na moeda da RESPOSTA, variação %, atraso do export. */

import { formatCalendarDate, formatInstant } from '@presentation/utils/dateTimeFormat';
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

/** 'YYYY-MM' do instante (UTC, o mesmo fuso em que o backend escolhe o mês corrente). */
export function currentMonthKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** Nome do mês ('2026-10' → "outubro" | "oct"), em UTC (`formatCalendarDate`) para não escorregar de mês por fuso. */
export function monthName(month: string, language: string | undefined, style: 'long' | 'short' = 'long'): string {
  const txt = formatCalendarDate(`${month}-01`, { month: style }, localeForLanguage(language));
  return txt ? txt.replace('.', '') : month;
}

/** Rótulo do seletor: "outubro de 2026" / "octubre de 2026". */
export function monthLabel(month: string, language: string | undefined): string {
  return formatCalendarDate(`${month}-01`, { month: 'long', year: 'numeric' }, localeForLanguage(language)) ?? month;
}

/** Mês anterior de 'YYYY-MM'. */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Nº de dias do mês 'YYYY-MM'. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' → "17/10" (curto) ou "17/10/2026" (longo); o mesmo dd/mm nos dois idiomas. Sem dia válido, devolve o texto cru. */
export function formatDay(day: string | null, style: 'short' | 'long' = 'short'): string {
  if (!day) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return style === 'short' ? `${m[3]}/${m[2]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

/** Percentual já em pontos (35.9 → "35,9%"); `digits` casas fixas. */
export function formatPercent(pct: number, language: string | undefined, digits = 1): string {
  return `${new Intl.NumberFormat(localeForLanguage(language), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(pct)}%`;
}

/** Fator "13,3×" (o × é o sinal de multiplicar, texto legítimo). */
export function formatFactor(factor: number, language: string | undefined): string {
  return `${new Intl.NumberFormat(localeForLanguage(language), { maximumFractionDigits: 1 }).format(factor)}×`;
}

/** Número curto de eixo/rótulo de gráfico (sem moeda): 3,1 · 41,2. */
export function formatPlain(value: number, language: string | undefined): string {
  return new Intl.NumberFormat(localeForLanguage(language), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
