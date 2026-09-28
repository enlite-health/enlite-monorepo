/**
 * As próximas `count` datas de um `weekday` (0=domingo … 6=sábado — a MESMA convenção do
 * `dayOfWeek` do `schedule`, segunda = 1: `E2E/helpers/lancamento-e2e-helper.ts:317`) a partir de
 * `asOf` (string `YYYY-MM-DD`, sempre a vinda da API — `ServiceTeam.asOf`, DX-13.13). Inclui o
 * próprio `asOf` quando ele já cai no `weekday` pedido; senão avança até o próximo. Só aritmética
 * `Date.UTC`/`getUTCDay` — NUNCA `Date.now()` nem `new Date()` sem argumento: o relógio e o fuso
 * do navegador não entram na conta (memória `teste-de-fuso-passa-por-coincidencia`).
 */
export function nextDatesOfWeekday(asOf: string, weekday: number, count: number): string[] {
  const [year, month, day] = asOf.split('-').map(Number);
  const asOfUtcMs = Date.UTC(year, month - 1, day);
  const asOfWeekday = new Date(asOfUtcMs).getUTCDay();
  const daysUntilFirst = (weekday - asOfWeekday + 7) % 7;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const firstUtcMs = asOfUtcMs + daysUntilFirst * oneDayMs;

  const dates: string[] = [];
  for (let i = 0; i < count; i += 1) {
    dates.push(new Date(firstUtcMs + i * 7 * oneDayMs).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * `YYYY-MM-DD` → `DD/MM` — fonte única (era duplicada em `SubstitutionDayModal.tsx` e
 * `ServiceTeamBoard.tsx`, G1-6). Só `split`, nunca `Date` do driver.
 */
export function formatDDMM(dateIso: string): string {
  const [, month, day] = dateIso.split('-');
  return `${day}/${month}`;
}

/**
 * Referência UTC de um domingo (2023-01-01) para nomear o dia da semana sem criar chave de i18n
 * (`weekday` 0=domingo…6=sábado, a mesma convenção do `dayOfWeek`/`nextDatesOfWeekday`). Fonte
 * única (Fase 12, DX-12.12 (i)): o modal "Sustituir un día" e o itinerário importam daqui. Só o NOME do dia (`Intl`, locale do idioma ativo) — nunca a
 * data em si, que vem sempre de `nextDatesOfWeekday`.
 */
export const WEEKDAY_REFERENCE_UTC_MS = Date.UTC(2023, 0, 1);

export function weekdayName(weekday: number, language: string): string {
  const locale = language.startsWith('pt') ? 'pt-BR' : 'es-AR';
  const ms = WEEKDAY_REFERENCE_UTC_MS + weekday * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(ms));
}
