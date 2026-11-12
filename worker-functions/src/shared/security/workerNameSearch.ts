/**
 * Busca de prestador por texto livre — UM só lugar (lista de prestadores e lista de pessoas da aba "Vínculos de área").
 *
 * O nome é cifrado (KMS) e só se busca por blind index (`name_trgm_bidx`, mín. 3 caracteres): o banco devolve um
 * conjunto de CANDIDATOS (teto `WORKER_SEARCH_CANDIDATE_LIMIT`), o chamador decifra e `matchesSearch` confere de verdade.
 * E-mail e telefone são colunas em claro: `ILIKE`. Nada aqui loga o termo.
 */
import { normalizeSearch } from '../utils/normalizeSearch';
import type { BlindIndexService } from './BlindIndexService';
import type { KMSEncryptionService } from './KMSEncryptionService';

/** Teto de candidatos do conjunto da busca por nome (a página é fatiada em memória depois de conferir). */
export const WORKER_SEARCH_CANDIDATE_LIMIT = 200;

export type WorkerSearchPlan =
  | { kind: 'email'; like: string }
  | { kind: 'phone'; like: string }
  | { kind: 'name'; raw: string; term: string };

/** Classifica o termo: com `@` → e-mail; 4+ dígitos → telefone; senão → nome. Vazio → `null` (sem busca). */
export function planWorkerSearch(search: string | undefined): WorkerSearchPlan | null {
  const raw = search?.trim();
  if (!raw) return null;
  const term = raw.toLowerCase();
  if (raw.includes('@')) return { kind: 'email', like: `%${term}%` };
  const digits = raw.replace(/[\s+\-()]/g, '');
  if (/^\d{4,}$/.test(digits)) return { kind: 'phone', like: `%${digits}%` };
  return { kind: 'name', raw, term };
}

export type NameSearchBidx = { ok: true; literal: string } | { ok: false; error: string };

/** Literal `bytea[]` do blind index do termo, para `name_trgm_bidx @> $n::bytea[]`; termo curto demais → erro de 400. */
export async function nameSearchBidxLiteral(blindIndex: BlindIndexService, raw: string): Promise<NameSearchBidx> {
  let literal: string | null;
  try {
    literal = blindIndex.serializeForPg(await blindIndex.generateSearchTrigramBidx(raw));
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid search term' };
  }
  if (literal === null) return { ok: false, error: 'Search term must have at least 3 characters' };
  return { ok: true, literal };
}

/** Decifra nome e sobrenome de uma linha de `workers` (`''` quando ausente). */
export async function decryptWorkerName(
  kms: KMSEncryptionService,
  row: { first_name_encrypted?: unknown; last_name_encrypted?: unknown },
): Promise<{ firstName: string; lastName: string }> {
  const [firstName, lastName] = await Promise.all([
    kms.decrypt(row.first_name_encrypted as string | null),
    kms.decrypt(row.last_name_encrypted as string | null),
  ]);
  return { firstName: firstName ?? '', lastName: lastName ?? '' };
}

/** Todos os tokens do termo aparecem em algum campo; insensível a acento e caixa ("John Snow" casa em campos separados). */
export function matchesSearch(searchTerm: string, fields: string[]): boolean {
  const tokens = normalizeSearch(searchTerm).split(/\s+/).filter(Boolean);
  const concatenated = fields.map(normalizeSearch).join(' ');
  return tokens.every((token) => concatenated.includes(token));
}
