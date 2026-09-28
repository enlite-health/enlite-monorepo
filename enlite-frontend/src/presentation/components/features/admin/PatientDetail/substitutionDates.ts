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
