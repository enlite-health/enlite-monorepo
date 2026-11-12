/**
 * Estado da lista global de enquadres NA URL (spec 076): `parse(searchParams)` ↔ `serialize(filtros)`, e a régua do período.
 * URL vazia = sem datas = "a semana atual", resolvida pelo SERVIDOR (um favorito continua sendo "esta semana"); as datas só
 * entram na URL quando a pessoa edita uma — e sempre as DUAS. A régua do período é a do servidor (`enquadreListQuery.ts`):
 * 92 dias de calendário inclusivos e os mesmos `code`s, para o front reprovar SEM chamar a API.
 */
import type { EnquadreEventStatus } from '@domain/entities/EnquadreEvent';

export const MAX_RANGE_DAYS = 92;
/** 10/20/50 da spec + 100, que o `TablePagination` compartilhado oferece e o servidor aceita (limite máx. 100). */
export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const ENQUADRE_STATUSES: readonly EnquadreEventStatus[] = ['open', 'closed', 'cancelled'];

export type RangeErrorCode = 'ENQUADRE_LIST_RANGE_INCOMPLETE' | 'ENQUADRE_LIST_RANGE_INVERTED' | 'ENQUADRE_LIST_RANGE_TOO_LONG';

export interface EnquadresListFilters {
  /** `YYYY-MM-DD` ou `''` (= semana atual do servidor). */
  from: string;
  to: string;
  status: EnquadreEventStatus[];
  host: string;
  country: string;
  q: string;
  /** Base 1. */
  page: number;
  pageSize: number;
}

export const EMPTY_FILTERS: EnquadresListFilters = {
  from: '', to: '', status: [], host: '', country: '', q: '', page: 1, pageSize: DEFAULT_PAGE_SIZE,
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (ymd: string): number => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
const isDay = (v: string): boolean => YMD.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** `null` = período válido (ou vazio). Mesmos 92 dias e `code`s do servidor. */
export function validateRange(from: string, to: string): RangeErrorCode | null {
  if (from === '' && to === '') return null;
  if (from === '' || to === '' || !isDay(from) || !isDay(to)) return 'ENQUADRE_LIST_RANGE_INCOMPLETE';
  const diff = dayNumber(to) - dayNumber(from);
  if (diff < 0) return 'ENQUADRE_LIST_RANGE_INVERTED';
  if (diff > MAX_RANGE_DAYS - 1) return 'ENQUADRE_LIST_RANGE_TOO_LONG';
  return null;
}

const positiveInt = (v: string | null, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

export function parse(sp: URLSearchParams): EnquadresListFilters {
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const hasRange = isDay(from) && isDay(to);
  const size = Number(sp.get('pageSize'));
  const status = (sp.get('status') ?? '').split(',').filter((s): s is EnquadreEventStatus => (ENQUADRE_STATUSES as readonly string[]).includes(s));
  return {
    from: hasRange ? from : '',
    to: hasRange ? to : '',
    status: ENQUADRE_STATUSES.filter((s) => status.includes(s)),
    host: sp.get('host') ?? '',
    country: sp.get('country') ?? '',
    q: sp.get('q') ?? '',
    page: positiveInt(sp.get('page'), 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

/** Só grava o que difere do padrão: URL limpa = estado inicial. */
export function serialize(f: EnquadresListFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.from !== '' && f.to !== '') {
    sp.set('from', f.from);
    sp.set('to', f.to);
  }
  if (f.status.length > 0) sp.set('status', f.status.join(','));
  if (f.host !== '') sp.set('host', f.host);
  if (f.country !== '') sp.set('country', f.country);
  if (f.q.trim() !== '') sp.set('q', f.q.trim());
  if (f.page > 1) sp.set('page', String(f.page));
  if (f.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(f.pageSize));
  return sp;
}
