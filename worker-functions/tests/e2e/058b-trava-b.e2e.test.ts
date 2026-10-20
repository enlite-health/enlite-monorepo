/**
 * 058b-trava-b.e2e.test.ts @integration — spec 058 T216: a Trava B (`trg_058_b_pcs_providers_needed`) recusa baixar `providers_needed`
 * abaixo da ocupação, e recusa número → NULL; e a corrida A × B (PATCH do limite × alocação) nunca fecha com ocupação > limite.
 */
import { Pool } from 'pg';
import { alocar, criarCandidato, criarCenario, erroDe, hojeOp, limparB, novoPool } from './helpers/itinerario058bDb';
import type { PgErr } from './helpers/itinerario058bDb';

describe('058b Trava B: providers_needed do serviço @integration', () => {
  let pool: Pool;
  beforeAll(async () => { pool = novoPool(); await limparB(pool); });
  afterAll(async () => { await limparB(pool); await pool.end(); });

  const esperaCodigo = (e: PgErr | null, c: string): void => {
    expect(e?.code).toBe('P0001');
    expect(e?.message).toContain(c);
  };
  const setLimite = (serviceId: string, v: number | null) => () =>
    pool.query('UPDATE patient_contracted_services SET providers_needed = $1 WHERE id = $2', [v, serviceId]);
  const limiteDe = async (serviceId: string): Promise<number | null> =>
    (await pool.query<{ n: number | null }>('SELECT providers_needed AS n FROM patient_contracted_services WHERE id = $1', [serviceId])).rows[0].n;

  it('Trava B recusa: baixar abaixo da ocupação', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 3, faixas: 1 });
    const D = await hojeOp(pool);
    for (let i = 0; i < 3; i++) await alocar(pool, cen.faixas[0], await criarCandidato(pool, cen), D, null);
    esperaCodigo(await erroDe(setLimite(cen.serviceId, 2)), 'PROVIDERS_NEEDED_BELOW_OCCUPANCY');
  });

  it('Trava B recusa: número → NULL', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 1 });
    esperaCodigo(await erroDe(setLimite(cen.serviceId, null)), 'PROVIDERS_NEEDED_CANNOT_CLEAR');
  });

  it('Trava B recusa: NULL → número abaixo da ocupação', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 1 });
    const D = await hojeOp(pool);
    for (let i = 0; i < 2; i++) await alocar(pool, cen.faixas[0], await criarCandidato(pool, cen), D, null);
    esperaCodigo(await erroDe(setLimite(cen.serviceId, 1)), 'PROVIDERS_NEEDED_BELOW_OCCUPANCY');
  });

  it('Trava B positivos: mesmo valor é no-op pelo WHEN', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 1 });
    const D = await hojeOp(pool);
    for (let i = 0; i < 2; i++) await alocar(pool, cen.faixas[0], await criarCandidato(pool, cen), D, null);
    await pool.query('UPDATE patient_contracted_services SET providers_needed = 2 WHERE id = $1', [cen.serviceId]);
    expect(await limiteDe(cen.serviceId)).toBe(2);
  });

  it('Trava B positivos: subir é aceito', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 1 });
    const D = await hojeOp(pool);
    for (let i = 0; i < 2; i++) await alocar(pool, cen.faixas[0], await criarCandidato(pool, cen), D, null);
    await pool.query('UPDATE patient_contracted_services SET providers_needed = 3 WHERE id = $1', [cen.serviceId]);
    expect(await limiteDe(cen.serviceId)).toBe(3);
  });

  it('A × B: PATCH 3→2 aberto sem COMMIT × alocação do 3º — nunca termina com ocupação 3 e limite 2', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 3, faixas: 1 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, null);
    await alocar(pool, cen.faixas[0], w2, D, null);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('UPDATE patient_contracted_services SET providers_needed = 2 WHERE id = $1', [cen.serviceId]); // sem COMMIT (2 ≥ 2 passa)
      await b.query('BEGIN');
      let terminou = false;
      const pb = erroDe(() => alocar(b, cen.faixas[0], w3, D, null)).then((e) => { terminou = true; return e; });
      await new Promise((r) => setTimeout(r, 400));
      expect(terminou).toBe(false); // bloqueada no lock do serviço, não só atrasada
      await a.query('COMMIT');
      esperaCodigo(await pb, 'ITINERARY_SLOT_CAPACITY_EXCEEDED'); // a Trava A relê o limite 2 depois do COMMIT
      await b.query('ROLLBACK');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    const r = await pool.query<{ occ: number; lim: number }>(
      `SELECT (SELECT count(*) FROM patient_itinerary_assignment WHERE slot_id = $1 AND status = 'ACTIVE')::int AS occ,
              (SELECT providers_needed FROM patient_contracted_services WHERE id = $2) AS lim`, [cen.faixas[0], cen.serviceId]);
    expect(r.rows[0].occ).toBeLessThanOrEqual(r.rows[0].lim);
    expect(r.rows[0].lim).toBe(2);
  });
});
