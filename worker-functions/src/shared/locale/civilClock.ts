/**
 * civilClock — dia CIVIL (AAAA-MM-DD) sem depender do fuso do processo.
 *
 * Produção (Cloud Run) roda em UTC; os devs rodam em São Paulo (-03), que mascara bug de fuso. O incidente do Axonico (PR #770)
 * veio daí. Regra: data civil = Date à meia-noite UTC lida com getters UTC / `toISOString`; "hoje" de um país = `operationDateOf`
 * (reexportado aqui). Nunca `getHours()`, `setDate()`, `toISOString().slice(0,10)` ou `toLocale*String` sem `timeZone` em src/:
 * `__tests__/civilClockGuard.test.ts` barra.
 */
export { operationDateInZone, operationDateOf } from './operationDate';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Dia 'AAAA-MM-DD' de um Date que já representa uma data civil à meia-noite UTC (ex.: coluna `date` lida pelo driver). */
export function utcCivilDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Soma `n` dias a um dia civil 'AAAA-MM-DD' (aritmética em UTC: sem horário de verão no meio). */
export function addCivilDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return utcCivilDayOf(new Date(Date.UTC(y, m - 1, d + n)));
}

/** 'AAAA-MM-DD' de calendário REAL (rejeita `2026-02-30`, que `Date.parse` rolaria para março). */
export function isRealCivilDate(iso: string): boolean {
  if (!ISO_DAY.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && utcCivilDayOf(d) === iso;
}
