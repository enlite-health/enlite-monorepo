/**
 * Células do informe da guarda no painel (spec 092, DC-5/§Privacidade) e a REDAÇÃO do texto clínico.
 *
 *   `daily_report:read`            — estrutura do informe: data, prestador, respostas, notas, sinal imediato, atraso.
 *   `daily_report_narrative:read`  — o RELATÓRIO DESCRITIVO (texto clínico livre). Sem ela o campo vem `narrative: null` +
 *                                    `narrativeRedacted: true`, e o texto NEM É LIDO do banco (minimização: o SELECT já o recusa).
 *
 * `cells = null` (o engine não decidiu nesta request, D113) NÃO libera o texto: rota nova, dado clínico — fail-closed. Só a célula presente
 * na lista a libera. As duas células nascem fora de qualquer grupo (a concessão é da operação).
 */
export const DAILY_REPORT_RESOURCE = 'daily_report';
export const DAILY_REPORT_NARRATIVE_RESOURCE = 'daily_report_narrative';
export const DAILY_REPORT_NARRATIVE_READ_CELL = `${DAILY_REPORT_NARRATIVE_RESOURCE}:read`;

/** Só com a célula EXPLÍCITA na lista; `null`/ausente → redige. */
export function canReadDailyReportNarrative(cells: readonly string[] | null | undefined): boolean {
  return cells !== null && cells !== undefined && cells.includes(DAILY_REPORT_NARRATIVE_READ_CELL);
}

/** Rótulo da trilha de leitura (valor ENUMERADO, sem dado): quem abriu o texto fica distinguível de quem abriu só a estrutura. */
export function dailyReportTrailAction(cells: readonly string[] | null | undefined): string {
  return canReadDailyReportNarrative(cells) ? 'read_daily_reports:narrative' : 'read_daily_reports';
}
