/**
 * isTransientHttpStatus — classifica um status HTTP como transiente (retryable: 429 ou 5xx) ou
 * definitivo. Extraído porque `AnaCareSessionClient.ts` (classifica o `Response.status` bruto do
 * fetch) e `AnaCareRateLimiter.ts` (classifica `AnaCareHttpError.status` no `defaultIsTransient`)
 * repetiam a mesma lista de status — achado do gate `revisao-pr` na F2 de
 * `anacare-conferencia-de-horas`.
 *
 * Escopo desta extração: só a lista de status. Não mexe na decisão mais ampla de "isso é
 * transiente?" fora do HTTP (timeout de rede etc.) — essa continua local a cada chamador, como já
 * documentado em `backoff.ts`.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
