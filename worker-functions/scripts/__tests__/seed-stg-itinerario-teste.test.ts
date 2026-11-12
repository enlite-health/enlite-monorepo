import { assertStgApiUrl, assertStgDsn, main, STG_API_URL, type SeedDeps } from '../seed-stg-itinerario-teste';

const PRD_LIKE = [
  'https://worker-functions-prd.example.run.app',
  'http://localhost:8080',
  'https://worker-functions-vtf37eainq-tl.a.run.app.evil.com',
  'http://worker-functions-vtf37eainq-tl.a.run.app',
  'https://worker-functions-vtf37eainq-tl.a.run.app:8443',
  'not a url',
];

function spyDeps(): SeedDeps & { calls: { fetch: number; token: number; sql: number } } {
  const calls = { fetch: 0, token: 0, sql: 0 };
  return {
    calls,
    fetch: async () => { calls.fetch += 1; return { status: 200, text: async () => '{}' }; },
    getToken: () => { calls.token += 1; throw new Error('parou-no-token'); },
    sql: () => { calls.sql += 1; return ''; },
    log: () => undefined,
  };
}

describe('seed-stg-itinerario-teste — guarda de alvo (só stg)', () => {
  it.each(PRD_LIKE)('assertStgApiUrl recusa %s', (url) => {
    expect(() => assertStgApiUrl(url)).toThrow(/stg|inválida/);
  });

  it('assertStgApiUrl aceita a URL da stg', () => {
    expect(assertStgApiUrl(STG_API_URL)).toBe(STG_API_URL);
  });

  it.each(['postgresql://enlite_app@127.0.0.1:5435/enlite_ar', 'postgresql://enlite_app@127.0.0.1:5439/gbrain', 'postgresql://enlite_app@10.0.0.1:5434/enlite_ar'])(
    'assertStgDsn recusa %s', (dsn) => {
      expect(() => assertStgDsn(dsn)).toThrow(/stg/);
    });

  it.each(PRD_LIKE)('main recusa %s ANTES de qualquer rede, token ou SQL (morre se a guarda sair)', async (url) => {
    const deps = spyDeps();
    await expect(main(['--api-url', url], deps)).rejects.toThrow();
    expect(deps.calls).toEqual({ fetch: 0, token: 0, sql: 0 });
  });

  it('controle positivo: com a URL da stg o main passa da guarda e chega ao token', async () => {
    const deps = spyDeps();
    await expect(main(['--api-url', STG_API_URL], deps)).rejects.toThrow('parou-no-token');
    expect(deps.calls.token).toBe(1);
  });

  it('--cleanup também passa pela guarda', async () => {
    const deps = spyDeps();
    await expect(main(['--cleanup', '--api-url', PRD_LIKE[0]], deps)).rejects.toThrow(/stg/);
    expect(deps.calls.token).toBe(0);
  });
});
