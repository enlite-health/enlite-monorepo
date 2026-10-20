/**
 * Datas do cadastro da obra social. O fio fala `YYYY-MM-DD` (dia de calendário, sem hora) e o "hoje" é o `asOf` da resposta:
 * nada aqui lê o relógio do navegador. Comparar `YYYY-MM-DD` como string é correto (ordem lexicográfica = cronológica).
 */

/** `2026-10-19` → `19/10/2026`. Valor fora do formato volta como veio (nunca lança). */
export function formatCalendarDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

/** `true` quando `a` é um dia anterior a `b` (ambos `YYYY-MM-DD`, não vazios). */
export function isDayBefore(a: string, b: string): boolean {
  return a !== '' && b !== '' && a < b;
}
