import { runBackfill, parseArgs } from '../backfill-geocode-quality';

const LOCAL = 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const REMOTO = 'postgresql://u:p@10.0.0.5:5432/enlite_ar';
const ok = (lt: string, pm = false) => ({ latitude: 1, longitude: 2, locationType: lt, partialMatch: pm });
const row = (id: string) => ({ id, address_formatted: `Calle ${id} 100`, address_raw: null, neighborhood: null, city: null, state: null });

function mk(rows: any[], geocodeImpl?: jest.Mock) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: rows.length }] };
      if (/^\s*SELECT/.test(sql)) return { rows };
      return { rows: [] };
    }),
  };
  const geocodeBatch = geocodeImpl ?? jest.fn(async (qs: string[]) => qs.map(() => ok('ROOFTOP')));
  const updates = () => queries.filter((q) => /^\s*UPDATE/.test(q.sql));
  return { pool, geocoder: { geocodeBatch } as any, geocodeBatch, updates, log: jest.fn() };
}

describe('backfill-geocode-quality', () => {
  it('sem flag = dry-run: conta, não chama o geocoder e não faz UPDATE', async () => {
    const m = mk([row('a'), row('b')]);
    const opts = parseArgs([]);
    expect(opts.execute).toBe(false);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m.log }, opts);
    expect(r).toMatchObject({ mode: 'dry-run', candidates: 2, updated: 0 });
    expect(m.geocodeBatch).not.toHaveBeenCalled();
    expect(m.updates()).toHaveLength(0);
    expect(m.log).toHaveBeenCalledWith('2 endereços sem geocode_quality (dry-run: nada chamado, nada gravado)');
  });

  it('--execute com 3 candidatas: 3 UPDATEs com os 3 campos, filtrando por id', async () => {
    const m = mk([row('a'), row('b'), row('c')]);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m.log }, { execute: true, limit: 100, timeoutMs: 20 });
    expect(r).toMatchObject({ updated: 3, failed: 0 });
    const ups = m.updates();
    expect(ups).toHaveLength(3);
    ups.forEach((u, i) => {
      expect(u.sql).toContain('geocode_quality = $1');
      expect(u.sql).toContain('geocode_partial_match = $2');
      expect(u.sql).toContain('geocoded_at = $3');
      expect(u.params![0]).toBe('ROOFTOP');
      expect(u.params![1]).toBe(false);
      expect(u.params![2]).toBeInstanceOf(Date);
      expect(u.params![3]).toBe(['a', 'b', 'c'][i]);
    });
  });

  it('geocoder falhando em 1 de 3: 2 UPDATEs + 1 falha contada, sem lançar', async () => {
    const g = jest.fn(async (qs: string[]) => qs.map((q) => (q.includes('Calle b') ? null : ok('RANGE_INTERPOLATED', true))));
    const m = mk([row('a'), row('b'), row('c')], g);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m.log }, { execute: true, limit: 100, timeoutMs: 20 });
    expect(r).toMatchObject({ candidates: 3, updated: 2, failed: 1 });
    expect(m.updates()).toHaveLength(2);
    expect(m.updates()[0].params![1]).toBe(true);
  });

  it('geocoder que lança em 1: as outras seguem', async () => {
    const g = jest.fn(async (qs: string[]) => {
      if (qs[0].includes('Calle b')) throw new Error('boom');
      return qs.map(() => ok('ROOFTOP'));
    });
    const m = mk([row('a'), row('b'), row('c')], g);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m.log }, { execute: true, limit: 100, timeoutMs: 20 });
    expect(r).toMatchObject({ updated: 2, failed: 1 });
  });

  it('2ª execução (0 candidatas): 0 geocoder, 0 UPDATE', async () => {
    const m = mk([]);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m.log }, { execute: true, limit: 100, timeoutMs: 20 });
    expect(r).toMatchObject({ candidates: 0, updated: 0 });
    expect(m.geocodeBatch).not.toHaveBeenCalled();
    expect(m.updates()).toHaveLength(0);
  });

  it('--execute sem a chave: aborta sem consultar o banco nem chamar o geocoder', async () => {
    const m = mk([row('a')]);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: undefined, databaseUrl: LOCAL, log: m.log }, { execute: true, limit: 100, timeoutMs: 20 });
    expect(r.aborted).toMatch(/GOOGLE_MAPS_API_KEY/);
    expect(m.pool.query).not.toHaveBeenCalled();
    expect(m.geocodeBatch).not.toHaveBeenCalled();
  });

  it('UPDATE nunca menciona lat/lng; SELECT só pega vivos não classificados; log sem endereço', async () => {
    const m = mk([row('a')], jest.fn(async () => [null]));
    await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m.log }, { execute: true, limit: 7, timeoutMs: 20 });
    const m2 = mk([row('a')]);
    await runBackfill({ pool: m2.pool, geocoder: m2.geocoder, apiKey: 'k', databaseUrl: LOCAL, log: m2.log }, { execute: true, limit: 7, timeoutMs: 20 });
    expect(m2.updates()[0].sql).not.toMatch(/\blat\b|\blng\b/);
    const sel = m2.pool.query.mock.calls[0];
    expect(sel[0]).toContain('archived_at IS NULL');
    expect(sel[0]).toContain('geocode_quality IS NULL');
    expect(sel[1]).toEqual([7]);
    const logs = [...m.log.mock.calls, ...m2.log.mock.calls].flat().join('\n');
    expect(logs).not.toContain('Calle');
  });

  it('--execute contra alvo não-local SEM --eu-sei-que-e-producao: aborta, 0 geocoder, 0 UPDATE; com a flag passa', async () => {
    const m = mk([row('a')]);
    const r = await runBackfill({ pool: m.pool, geocoder: m.geocoder, apiKey: 'k', databaseUrl: REMOTO, log: m.log }, { execute: true, limit: 100, timeoutMs: 20 });
    expect(r.aborted).toMatch(/ALVO RECUSADO.*--eu-sei-que-e-producao/);
    expect(m.pool.query).not.toHaveBeenCalled();
    expect(m.geocodeBatch).not.toHaveBeenCalled();
    expect(m.updates()).toHaveLength(0);
    const ok2 = mk([row('a')]);
    const r2 = await runBackfill({ pool: ok2.pool, geocoder: ok2.geocoder, apiKey: 'k', databaseUrl: REMOTO, log: ok2.log }, { execute: true, limit: 100, timeoutMs: 20, producaoAutorizada: true });
    expect(r2).toMatchObject({ updated: 1 });
    // dry-run não passa pela trava
    const d = mk([row('a')]);
    const r3 = await runBackfill({ pool: d.pool, geocoder: d.geocoder, databaseUrl: REMOTO, log: d.log }, { execute: false, limit: 100 });
    expect(r3.mode).toBe('dry-run');
  });

  it('parseArgs: limit default 100 e --limit N', () => {
    expect(parseArgs([]).limit).toBe(100);
    expect(parseArgs(['--execute', '--limit', '5'])).toMatchObject({ execute: true, limit: 5 });
  });
});
