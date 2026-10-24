/**
 * dateRangeWire — DONO ÚNICO da conversão `daterange '[)'` (banco) <-> `{ validFrom, validTo | null }` (fio) — spec 058 §3.2 §V, plan §1.2 (B2).
 *
 * No banco a vigência é meio-aberta: `lower` inclusivo, `upper` EXCLUSIVO (o dia seguinte ao último vigente). No fio `validTo` é INCLUSIVO
 * (o último dia vigente). A fronteira de 1 dia mora SÓ aqui; `upper` infinito <-> `validTo: null`. §T, §G, §L, §E, o escritor e o front
 * consomem o wire sem converter, e nenhum outro arquivo escreve `'[)'`/`::daterange`/`upper(valid)` (grep-teste `src/__tests__/grep/`).
 *
 * Datas são strings ISO `AAAA-MM-DD` (nunca `Date`): sem fuso, sem "hoje" (o "hoje" é de `shared/locale/operationDate.ts`).
 */
export interface WireRange {
  validFrom: string;
  validTo: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_TEXT = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})?\)$/;

function assertIso(value: string): void {
  if (!ISO_DATE.test(value)) throw new Error(`data ISO inválida: ${JSON.stringify(value)}`);
}

/** `iso` deslocado em `days` dias (UTC puro, sem fuso). */
function shiftDay(iso: string, days: number): string {
  assertIso(iso);
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** O dia seguinte a `iso` (ex.: o dia do `NO_TERM` é o dia seguinte ao `validTo` do último termo). */
export function dayAfter(iso: string): string {
  return shiftDay(iso, 1);
}

/** Texto de `daterange` do banco (`[2026-03-01,2026-04-01)`, `[2026-03-01,)`) -> wire. `validTo` = upper - 1 dia; upper infinito -> `null`. */
export function toWire(range: string): WireRange {
  const m = RANGE_TEXT.exec(range);
  if (!m) throw new Error(`daterange fora do formato [desde,até): ${JSON.stringify(range)}`);
  return { validFrom: m[1], validTo: m[2] === undefined ? null : shiftDay(m[2], -1) };
}

/** Wire -> texto de `daterange` meio-aberto. `validTo: null` = sem fim. `validTo < validFrom` lança. */
export function fromWire(wire: WireRange): string {
  assertIso(wire.validFrom);
  if (wire.validTo === null) return `[${wire.validFrom},)`;
  assertIso(wire.validTo);
  if (wire.validTo < wire.validFrom) throw new Error('validTo anterior a validFrom');
  return `[${wire.validFrom},${shiftDay(wire.validTo, 1)})`;
}

/**
 * O trecho ANTERIOR que sobra quando um vínculo vivo de início `lower` é substituído a partir de `newFrom`: `[lower, newFrom)`.
 * `null` quando `lower = newFrom` (ficaria vazio -> o caso é `SAME_START_USE_CORRECTION`, corrigir em vez de trocar).
 */
export function reinsertClosed(lower: string, newFrom: string): string | null {
  assertIso(lower);
  assertIso(newFrom);
  if (newFrom < lower) throw new Error('newFrom anterior ao início do vínculo vivo');
  return isSameStart(lower, newFrom) ? null : `[${lower},${newFrom})`;
}

/**
 * Fecha a faixa de texto `range` (`[desde,)` ou `[desde,até)`) em `hoje`, EXCLUSIVO: `[desde, hoje)` (vigente até ontem). Faixa que nasceu `hoje`
 * (`desde = hoje`) fica `'empty'` — "nunca vigente" (o `daterange` vazio do banco). `hoje` antes do início lança (o banco também recusaria).
 */
export function closeRangeAt(range: string, hoje: string): string {
  assertIso(hoje);
  const { validFrom } = toWire(range);
  if (hoje < validFrom) throw new Error('hoje anterior ao início da faixa');
  return hoje === validFrom ? 'empty' : `[${validFrom},${hoje})`;
}

/** O novo vínculo começa no mesmo dia do vivo -> `SAME_START_USE_CORRECTION` (recusado antes do banco). */
export function isSameStart(lower: string, newFrom: string): boolean {
  assertIso(lower);
  assertIso(newFrom);
  return lower === newFrom;
}
