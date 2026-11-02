/** Formatação do painel de custos (spec 082): dinheiro na moeda da RESPOSTA, variação %, atraso do export. */

const HORAS_ATRASO = 36;

export const locale = (language: string | undefined): string => (language === 'pt-BR' ? 'pt-BR' : 'es-AR');

/** Valor na `currency` da resposta; sem moeda (estado vazio) cai para número puro. */
export function formatMoney(value: number, currency: string | null, language: string | undefined): string {
  const loc = locale(language);
  if (!currency) return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(value);
  return new Intl.NumberFormat(loc, { style: 'currency', currency }).format(value);
}

/** (atual − base) / base em %, com sinal. `null` quando não há base (ausente ou zero): a tela mostra "—". */
export function formatVariation(current: number, base: number | null, language: string | undefined): string | null {
  if (base === null || base === 0) return null;
  const pct = ((current - base) / base) * 100;
  const txt = new Intl.NumberFormat(locale(language), { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(pct);
  return `${txt}%`;
}

export function isExportStale(dataUntil: string | null, now: number = Date.now()): boolean {
  if (!dataUntil) return false;
  const ts = Date.parse(dataUntil);
  return Number.isFinite(ts) && now - ts > HORAS_ATRASO * 3_600_000;
}

export function formatDateTime(iso: string, language: string | undefined): string {
  return new Date(iso).toLocaleString(locale(language));
}
