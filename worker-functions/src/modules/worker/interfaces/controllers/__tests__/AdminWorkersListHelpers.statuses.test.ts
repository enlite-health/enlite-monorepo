/**
 * AdminWorkersListHelpers.statuses.test.ts
 *
 * A regra de `statuses` (lista, usada pelo mapa) escrita na interface:
 * manda sobre `status` e sobre o exclude de DISABLED; `docs_complete` entra
 * por interseção; interseção vazia é lista vazia — nunca um WHERE com duas
 * condições de status que se contradizem. E `locationMatchSql`, o predicado
 * que o EXISTS da lista e o LATERAL do mapa compartilham.
 */
import { buildWorkerListWhereClause, locationMatchSql } from '../AdminWorkersListHelpers';
import { resolveLocationFilter } from '@shared/utils/normalizeLocationValue';

const PAGE = { limit: '10', offset: '0' };
const statusMentions = (sql: string): number => (sql.match(/w\.status/g) ?? []).length;

describe('buildWorkerListWhereClause — statuses (lista)', () => {
  it('lista explícita vira ANY e o exclude de DISABLED da casa NÃO entra', () => {
    const { whereClause, params, paramIndex } = buildWorkerListWhereClause({ ...PAGE, statuses: ['DISABLED', 'REGISTERED'] });
    expect(whereClause).toContain('AND w.status = ANY($1::text[])');
    expect(whereClause).not.toContain("<> 'DISABLED'");
    expect(statusMentions(whereClause)).toBe(1);
    expect(params).toEqual([['DISABLED', 'REGISTERED']]);
    expect(paramIndex).toBe(2);
  });

  it('statuses tem precedência sobre status (singular)', () => {
    const { whereClause, params } = buildWorkerListWhereClause({ ...PAGE, statuses: ['REGISTERED'], status: 'DISABLED' });
    expect(whereClause).toContain('w.status = ANY($1::text[])');
    expect(whereClause).not.toContain('w.status = $');
    expect(params).toEqual([['REGISTERED']]);
  });

  it('lista vazia é ignorada: cai na regra antiga (status singular ou exclude da casa)', () => {
    expect(buildWorkerListWhereClause({ ...PAGE, statuses: [] }).whereClause).toContain("COALESCE(w.status, '') <> 'DISABLED'");
    const single = buildWorkerListWhereClause({ ...PAGE, statuses: [], status: 'DISABLED' });
    expect(single.whereClause).toContain('w.status = $1');
    expect(single.params).toEqual(['DISABLED']);
  });

  it('docs_complete RESTRINGE a lista por interseção — uma única condição de status', () => {
    const complete = buildWorkerListWhereClause({ ...PAGE, statuses: ['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED'], docs_complete: 'complete' });
    expect(complete.params).toEqual([['REGISTERED']]);
    expect(complete.whereClause).not.toContain("w.status = 'REGISTERED'");
    expect(statusMentions(complete.whereClause)).toBe(1);

    const incomplete = buildWorkerListWhereClause({ ...PAGE, statuses: ['REGISTERED', 'INCOMPLETE_REGISTER'], docs_complete: 'incomplete' });
    expect(incomplete.params).toEqual([['INCOMPLETE_REGISTER']]);
    expect(statusMentions(incomplete.whereClause)).toBe(1);
  });

  it('pedido contraditório (DISABLED + incomplete) → interseção vazia, e nunca `status = X AND status = ANY`', () => {
    const { whereClause, params } = buildWorkerListWhereClause({ ...PAGE, statuses: ['DISABLED'], docs_complete: 'incomplete' });
    expect(params).toEqual([[]]);
    expect(statusMentions(whereClause)).toBe(1);
    expect(whereClause).not.toContain("w.status = 'INCOMPLETE_REGISTER'");
  });

  it('docs_complete desconhecido com statuses: a lista passa intacta', () => {
    const { params } = buildWorkerListWhereClause({ ...PAGE, statuses: ['REGISTERED', 'DISABLED'], docs_complete: 'whatever' });
    expect(params).toEqual([['REGISTERED', 'DISABLED']]);
  });

  it('sem statuses, docs_complete continua como sempre foi (cláusula literal)', () => {
    expect(buildWorkerListWhereClause({ ...PAGE, docs_complete: 'complete' }).whereClause).toContain("w.status = 'REGISTERED'");
    expect(buildWorkerListWhereClause({ ...PAGE, docs_complete: 'incomplete' }).whereClause).toContain("w.status = 'INCOMPLETE_REGISTER'");
    expect(buildWorkerListWhereClause({ ...PAGE, docs_complete: 'x' }).whereClause).not.toContain("w.status = '");
  });
});

describe('locationMatchSql — o predicado compartilhado por EXISTS (lista) e LATERAL (mapa)', () => {
  it('chave exata: coluna primária OU work_zone, no alias pedido', () => {
    const params: unknown[] = [];
    const { sql, paramIndex } = locationMatchSql('s', params, 1, 'state', resolveLocationFilter('Córdoba'));
    expect(sql).toBe('(lower(btrim(s.state)) = ANY($1::text[]) OR lower(btrim(s.work_zone)) = ANY($1::text[]))');
    expect(params).toEqual([['córdoba']]);
    expect(paramIndex).toBe(2);
  });

  it('grupo com padrões (CABA): exato + ILIKE em work_zone/interest_zone, dois params', () => {
    const params: unknown[] = [];
    const { sql, paramIndex } = locationMatchSql('wsa', params, 5, 'city', resolveLocationFilter('CABA'));
    expect(sql).toContain('lower(btrim(wsa.city)) = ANY($5::text[])');
    expect(sql).toContain('wsa.work_zone ILIKE ANY($6::text[])');
    expect(sql).toContain('wsa.interest_zone ILIKE ANY($6::text[])');
    expect(paramIndex).toBe(7);
    expect(params).toHaveLength(2);
    expect((params[1] as string[]).every((p) => p.startsWith('%') && p.endsWith('%'))).toBe(true);
  });

  it('match vazio → sql null, sem consumir param', () => {
    const params: unknown[] = [];
    expect(locationMatchSql('s', params, 3, 'city', { exactKeys: [], containsPatterns: [] })).toEqual({ sql: null, paramIndex: 3 });
    expect(params).toEqual([]);
  });

  it('o EXISTS da lista usa exatamente este predicado com o alias wsa', () => {
    const params: unknown[] = [];
    const pred = locationMatchSql('wsa', params, 1, 'state', resolveLocationFilter('Córdoba')).sql;
    const { whereClause } = buildWorkerListWhereClause({ ...PAGE, state: 'Córdoba' });
    expect(whereClause).toContain(`EXISTS (SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = w.id AND ${pred})`);
  });
});
