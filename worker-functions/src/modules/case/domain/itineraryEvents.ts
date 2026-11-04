/**
 * itineraryEvents — funções de DATA do itinerário (D445.3/D445.4), sobre string `YYYY-MM-DD` e sempre por `Date.UTC`
 * (nunca o fuso do processo). A expansão faixa × data (ocorrências, "Sin cubrir") mora em `serviceOccurrences.ts`
 * (spec 069, FR-12): a cópia local da vigência da alocação e a expansão antiga saíram daqui; a vigência é a de `isVigente`.
 */

/** `YYYY-MM-DD` → dia da semana (0 = domingo … 6 = sábado), sempre por `Date.UTC` — nunca fuso local do processo. */
export function weekdayOfDateString(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `YYYY-MM-DD` + N dias (N pode ser negativo), sempre por `Date.UTC`. */
export function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Quantidade de dias no intervalo `[from, to]`, inclusive dos dois extremos (1 dia = mesma data). */
export function dayCountInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}
