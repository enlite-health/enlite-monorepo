/**
 * liveVacancyOfService (spec 047, F2) — o dono da leitura da vaga viva do serviço contratado.
 * Pool mockado; a prova com banco real é o e2e `tests/e2e/vacante-em-servico-047-api.e2e.test.ts`.
 */
const mockShortLinkCall = jest.fn();
jest.mock('../../../matching/infrastructure/shortlinks/ShortLinkService', () => ({
  ShortLinkService: jest.fn().mockImplementation(() => ({ buildAndCreate: mockShortLinkCall, delete: mockShortLinkCall })),
}));

import type { Pool } from 'pg';
import { fetchLiveVacancies } from '../liveVacancyOfService';
import { VACANCY_CASE_NUMBER_SQL } from '@shared/sql/vacancyCaseNumberSql';

const pool = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool & { query: jest.Mock });

describe('fetchLiveVacancies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lista vazia de serviços → mapa vazio, sem tocar o banco', async () => {
    const p = pool([]);
    expect((await fetchLiveVacancies(p, [])).size).toBe(0);
    expect(p.query).not.toHaveBeenCalled();
  });

  it('A1: devolve o objeto com as 4 chaves, por serviço; o SQL pega a vaga viva MAIS ANTIGA com o caso do fragmento com dono', async () => {
    const p = pool([{ contracted_service_id: 's1', id: 'v1', case_number: 1234, case_ordinal: 2, status: 'SEARCHING' }]);
    const out = await fetchLiveVacancies(p, ['s1', 's2']);
    expect(out.get('s1')).toEqual({ id: 'v1', caseNumber: 1234, caseOrdinal: 2, status: 'SEARCHING' });
    expect(out.has('s2')).toBe(false);
    const [sql, params] = p.query.mock.calls[0];
    expect(params).toEqual([['s1', 's2']]);
    expect(sql).toContain('DISTINCT ON (jp.contracted_service_id)');
    expect(sql).toContain('ORDER BY jp.contracted_service_id, jp.created_at ASC');
    expect(sql).toContain('jp.deleted_at IS NULL');
    expect(sql).toContain(`${VACANCY_CASE_NUMBER_SQL} AS case_number`);
  });

  it('A4: sem caso / sem ordinal → null em cada campo; a vaga NÃO tem siteUrl, o SQL NÃO toca social_short_links e o ShortLinkService NÃO é chamado', async () => {
    const p = pool([{ contracted_service_id: 's1', id: 'v1', case_number: null, case_ordinal: null, status: null }]);
    const out = await fetchLiveVacancies(p, ['s1']);
    expect(out.get('s1')).toEqual({ id: 'v1', caseNumber: null, caseOrdinal: null, status: null });
    expect(Object.keys(out.get('s1') as object)).not.toContain('siteUrl');
    expect(p.query.mock.calls[0][0]).not.toContain('social_short_links');
    expect(mockShortLinkCall).toHaveBeenCalledTimes(0);
  });
});
