/**
 * Regras PURAS da lista global de enquadres (spec 076). Sem I/O.
 *
 * - Intervalo Desde/Hasta: dias de calendário (YYYY-MM-DD), ambos ou nenhum; nenhum = a semana atual, que o SERVIDOR resolve
 *   no SQL com `CURRENT_WEEK_START_SQL` (mesma definição do indicador 21). No máximo `MAX_RANGE_DAYS` dias, inclusivos.
 * - Busca `q`: só pelo código do evento (`ENC-…`) ou pelo número do caso (`EN1234#02`). NUNCA nome de paciente nem de
 *   prestador: o texto digitado pode ser um nome e não vira predicado.
 */

/** Intervalo máximo (dias de calendário, inclusivos) entre Desde e Hasta — P-3 da spec 076. */
export const MAX_RANGE_DAYS = 92;

export type EnquadreListRangeErrorCode =
  | 'ENQUADRE_LIST_RANGE_INCOMPLETE'
  | 'ENQUADRE_LIST_RANGE_INVERTED'
  | 'ENQUADRE_LIST_RANGE_TOO_LONG';

/** Erro de domínio com `code` estável: a tela traduz pelo `code`, nunca pela mensagem. */
export class EnquadreListRangeError extends Error {
  constructor(public readonly code: EnquadreListRangeErrorCode, message: string) {
    super(message);
    this.name = 'EnquadreListRangeError';
  }
}

export interface EnquadreListRange {
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);
}

/**
 * `null` = nenhuma data (semana atual, resolvida pelo servidor). Só um dos lados, invertido ou longo demais = erro.
 * Espera `YYYY-MM-DD` já validado (o controller valida o formato antes).
 */
export function parseEnquadreListRange(from?: string | null, to?: string | null): EnquadreListRange | null {
  const hasFrom = typeof from === 'string' && from !== '';
  const hasTo = typeof to === 'string' && to !== '';
  if (!hasFrom && !hasTo) return null;
  if (!hasFrom || !hasTo) {
    throw new EnquadreListRangeError('ENQUADRE_LIST_RANGE_INCOMPLETE', 'from e to andam juntos');
  }
  const diff = dayNumber(to) - dayNumber(from);
  if (diff < 0) throw new EnquadreListRangeError('ENQUADRE_LIST_RANGE_INVERTED', 'to anterior a from');
  if (diff > MAX_RANGE_DAYS - 1) {
    throw new EnquadreListRangeError('ENQUADRE_LIST_RANGE_TOO_LONG', `intervalo acima de ${MAX_RANGE_DAYS} dias`);
  }
  return { from, to };
}

export interface EnquadreSearch {
  /** Trecho do código do evento, em maiúsculas (`ENC-AB12`). */
  eventCode?: string;
  /** Dígitos do número do caso/vaga. */
  digits?: string;
  /** Ordinal do caso (`#02` → 2). */
  ordinal?: number;
}

/** Texto livre → predicado fechado. O que não é código nem número de caso é ignorado (vira `{}`). */
export function parseEnquadreSearch(q?: string | null): EnquadreSearch {
  const text = (q ?? '').trim();
  if (text === '') return {};
  if (/^ENC-/i.test(text)) {
    const eventCode = text.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    return eventCode.length > 4 ? { eventCode } : {};
  }
  const ord = /#\s*(\d*)\s*$/.exec(text);
  const head = (ord ? text.slice(0, ord.index) : text).trim().replace(/^EN\s*/i, '');
  const out: EnquadreSearch = {};
  if (/^\d+$/.test(head)) out.digits = head;
  if (ord && ord[1] !== '') out.ordinal = Number(ord[1]);
  return out;
}
