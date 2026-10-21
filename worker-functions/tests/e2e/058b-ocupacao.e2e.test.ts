/**
 * 058b-ocupacao.e2e.test.ts @integration — spec 058 T213: ocupação máxima de uma faixa (`itinerary_slot_max_occupancy`) e a
 * medição 12a (`fn_058_b_slots_over_capacity`). Banco real; a Trava A é desligada só para semear.
 */
import { Pool } from 'pg';
import { alocar, criarCandidato, criarCenario, hojeOp, limparB, mais, novoPool, travaA } from './helpers/itinerario058bDb';

describe('058b ocupação da faixa @integration', () => {
  let pool: Pool;
  beforeAll(async () => { pool = novoPool(); await limparB(pool); });
  afterAll(async () => { await limparB(pool); await pool.end(); });

  const maxOcup = async (slot: string, de: string, ate: string | null, excluir: string | null = null): Promise<number> =>
    (await pool.query<{ n: number }>('SELECT itinerary_slot_max_occupancy($1::uuid, $2::date, $3::date, $4::uuid) AS n', [slot, de, ate, excluir])).rows[0].n;

  /** A ausência exige que `on_date` caia no dia da semana da faixa (segunda = 1): a 1ª segunda depois de D (1 a 7 dias). */
  const proximaSegunda = async (D: string): Promise<string> =>
    (await pool.query<{ d: string }>(`SELECT ($1::date + (((1 - extract(isodow FROM $1::date)::int + 6) % 7) + 1))::text AS d`, [D])).rows[0].d;

  /** Semeia com a Trava A desligada (quando existir), numa transação. */
  async function semear<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await travaA(c, false);
      const r = await fn(c);
      await travaA(c, true);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  it('ocupação: 2 entradas futuras escalonadas', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 1 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await semear(async (c) => {
      await alocar(c, cen.faixas[0], w1, D, null);
      await alocar(c, cen.faixas[0], w2, await mais(pool, D, 5), await mais(pool, D, 20));
      await alocar(c, cen.faixas[0], w3, await mais(pool, D, 10), null);
    });
    expect(await maxOcup(cen.faixas[0], D, null)).toBe(3);
    expect(await maxOcup(cen.faixas[0], D, await mais(pool, D, 4))).toBe(1);
  });

  it('ocupação: saída agendada', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 1 });
    const D = await hojeOp(pool);
    const [w1, w2] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await semear(async (c) => {
      await alocar(c, cen.faixas[0], w1, D, await mais(pool, D, 10));
      await alocar(c, cen.faixas[0], w2, await mais(pool, D, 5), null);
    });
    expect(await maxOcup(cen.faixas[0], D, null)).toBe(2);
    expect(await maxOcup(cen.faixas[0], await mais(pool, D, 11), null)).toBe(1);
  });

  it('ocupação: valid_to inclusivo (dia exato)', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 1 });
    const D = await hojeOp(pool);
    const [w1, w2] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await semear(async (c) => {
      await alocar(c, cen.faixas[0], w1, D, await mais(pool, D, 10));
      await alocar(c, cen.faixas[0], w2, await mais(pool, D, 10), null);
    });
    expect(await maxOcup(cen.faixas[0], D, null)).toBe(2);
  });

  it('substituto não conta', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 1 });
    const D = await hojeOp(pool);
    const [w1, w2] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await semear(async (c) => {
      const a1 = await alocar(c, cen.faixas[0], w1, D, null);
      await c.query(
        `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
         VALUES ($1, $2::date, $3, $4, 'qa058b', 'qa058b')`,
        [a1, await proximaSegunda(D), w2.workerId, w2.applicationId]);
    });
    expect(await maxOcup(cen.faixas[0], D, await mais(pool, D, 10))).toBe(1);
  });

  it('ocupação: p_exclude tira a própria linha', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 1 });
    const D = await hojeOp(pool);
    const w1 = await criarCandidato(pool, cen);
    const a1 = await semear((c) => alocar(c, cen.faixas[0], w1, D, null));
    expect(await maxOcup(cen.faixas[0], D, null, a1)).toBe(0);
    expect(await maxOcup(cen.faixas[0], D, null, null)).toBe(1);
  });

  it('fn_058_b_slots_over_capacity: devolve a faixa acima do limite, só ids e inteiros', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 1 });
    const D = await hojeOp(pool);
    const ids: string[] = [];
    await semear(async (c) => {
      for (let i = 0; i < 3; i++) ids.push(await alocar(c, cen.faixas[0], await criarCandidato(c, cen), D, null));
    });
    const r = await pool.query('SELECT * FROM fn_058_b_slots_over_capacity() WHERE service_id = $1', [cen.serviceId]);
    expect(r.rows).toHaveLength(1);
    expect(Object.keys(r.rows[0])).toEqual(['service_id', 'slot_id', 'providers_needed', 'max_occupancy']);
    expect(r.rows[0].providers_needed).toBe(2);
    expect(r.rows[0].max_occupancy).toBe(3);
    await semear((c) => c.query(`UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = $2::date WHERE id = $1`, [ids[0], D]));
    const r2 = await pool.query('SELECT * FROM fn_058_b_slots_over_capacity() WHERE service_id = $1', [cen.serviceId]);
    expect(r2.rows).toHaveLength(0);
  });
});
