/**
 * operationDate — "hoje" de um país (spec 058 §3.3, plan §5, C1).
 *
 * O dia de operação é a data LOCAL do país do serviço, não a do servidor nem a do navegador. Este arquivo é o ÚNICO dono dessa conta:
 * quem precisa de "hoje" (vigência de termo, vínculo, ficha, lista de pacientes) chama `operationDateOf(country, requestNow)` com o
 * `requestNow` capturado UMA vez no controller; nenhum outro arquivo novo faz `new Date()` para "hoje" (D-43).
 *
 * Diferente de `countryToTimezone` (que cai em 'UTC' para chave ausente e continua assim: 5 chamadores dependem disso), aqui país fora do
 * mapa LANÇA `UnknownCountryError` — um "hoje" calculado em UTC por engano pagaria o preço do dia errado.
 */
import { localParts } from '@modules/matching/domain/interviewSlotResolver';
import { COUNTRY_TIMEZONE_MAP } from './CountryTimezone';

export class UnknownCountryError extends Error {
  readonly code = 'UNKNOWN_COUNTRY';
  constructor(country: string) {
    super(`país fora do mapa de fusos: ${JSON.stringify(country)}`);
    this.name = 'UnknownCountryError';
  }
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Data local (AAAA-MM-DD) no fuso IANA `tz` no instante `now`. */
export function operationDateInZone(tz: string, now: Date): string {
  const p = localParts(now, tz);
  return `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)}`;
}

/** Data local do país no instante `now`; país fora de `COUNTRY_TIMEZONE_MAP` lança `UnknownCountryError` (nunca 'UTC'). */
export function operationDateOf(country: string, now: Date): string {
  if (!Object.prototype.hasOwnProperty.call(COUNTRY_TIMEZONE_MAP, country)) throw new UnknownCountryError(country);
  return operationDateInZone(COUNTRY_TIMEZONE_MAP[country], now);
}

/** `{ país: data local }` para TODAS as chaves de `map` (produção passa `COUNTRY_TIMEZONE_MAP`; o teste passa um mapa de fusos distintos). */
export function buildAsOfByCountry(map: Readonly<Record<string, string>>, now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [country, tz] of Object.entries(map)) out[country] = operationDateInZone(tz, now);
  return out;
}
