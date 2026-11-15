/**
 * A zona de atendimento herda o PAÍS DO CADASTRO do worker (`workers.country`), nunca um país fixo.
 * Antes gravava 'BR' literal para todo mundo (worker AR virava zona BR).
 */
import { ServiceAreaRepository } from '../ServiceAreaRepository';

const dto = {
  workerId: 'w-1', address: 'Av. Corrientes 1234', lat: -34.6, lng: -58.4, serviceRadiusKm: 10,
};

const makeRepo = (workerCountry: 'AR' | 'BR') => {
  // Pool fake que RESOLVE o subselect como o Postgres faria: country vem de `workers`, não do código.
  const query = jest.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    const subselect = /\(SELECT country FROM workers WHERE id = \$(\d+)\)/.exec(sql);
    const country = subselect ? workerCountry : (params.find((p) => p === 'BR' || p === 'AR') ?? null);
    return { rows: [{ id: 'sa-1', worker_id: params[0], address_line: 'x', latitude: '1', longitude: '2', radius_km: 10, country }] };
  });
  const repo = Object.create(ServiceAreaRepository.prototype) as ServiceAreaRepository;
  Object.assign(repo, { pool: { query } });
  return { repo, query };
};

describe('ServiceAreaRepository.create — país da zona = país do cadastro do worker', () => {
  it.each(['AR', 'BR'] as const)('worker %s → zona %s (subselect em workers, sem literal)', async (country) => {
    const { repo, query } = makeRepo(country);

    const res = await repo.create(dto);

    expect(res.isSuccess).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/\(SELECT country FROM workers WHERE id = \$1\)/);
    expect(params).not.toContain('BR');
    expect(params).not.toContain('AR');
    expect((await query.mock.results[0].value).rows[0].country).toBe(country);
  });
});
