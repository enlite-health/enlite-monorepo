/**
 * 058b-trava-a.e2e.test.ts @integration — spec 058 T215: a Trava A (`trg_058_b_assignment_capacity`) recusa alocação ACTIVE que passa de
 * `providers_needed` da faixa, de hoje (do país) em diante, e aceita o que não deve recusar. Banco real; fixtures sintéticas.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { alocar, criarCandidato, criarCenario, erroDe, hojeOp, limparB, mais, novoPool, travaA } from './helpers/itinerario058bDb';
import type { PgErr } from './helpers/itinerario058bDb';

describe('058b Trava A: capacidade da faixa @integration', () => {
  let pool: Pool;
  beforeAll(async () => { pool = novoPool(); await limparB(pool); });
  afterAll(async () => { await limparB(pool); await pool.end(); });

  const esperaExcedeu = (e: PgErr | null): void => {
    expect(e?.code).toBe('P0001');
    expect(e?.message).toContain('ITINERARY_SLOT_CAPACITY_EXCEEDED');
  };
  const upd = (sql: string, params: unknown[]) => () => pool.query(sql, params);
  /** A ausência exige `on_date` no dia da semana da faixa (F1 = segunda): a 1ª segunda depois de D. */
  const proximaSegunda = async (D: string): Promise<string> =>
    (await pool.query<{ d: string }>(`SELECT ($1::date + (((1 - extract(isodow FROM $1::date)::int + 6) % 7) + 1))::text AS d`, [D])).rows[0].d;

  it('Trava A recusa: INSERT na faixa cheia', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, null);
    await alocar(pool, cen.faixas[0], w2, D, null);
    esperaExcedeu(await erroDe(() => alocar(pool, cen.faixas[0], w3, D, null)));
  });

  it('Trava A recusa: reativar CANCELLED→ACTIVE acima do limite', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, null);
    await alocar(pool, cen.faixas[0], w2, D, null);
    const a3 = await alocar(pool, cen.faixas[0], w3, D, null, 'CANCELLED');
    esperaExcedeu(await erroDe(upd(`UPDATE patient_itinerary_assignment SET status = 'ACTIVE' WHERE id = $1`, [a3])));
  });

  it('Trava A recusa: trocar slot_id para faixa cheia', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, null);
    await alocar(pool, cen.faixas[0], w2, D, null);
    const a3 = await alocar(pool, cen.faixas[1], w3, D, null);
    esperaExcedeu(await erroDe(upd('UPDATE patient_itinerary_assignment SET slot_id = $1 WHERE id = $2', [cen.faixas[0], a3])));
  });

  it('Trava A recusa: estender valid_to acima do limite', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, await mais(pool, D, 30));
    await alocar(pool, cen.faixas[0], w2, await mais(pool, D, 10), null);
    const a3 = await alocar(pool, cen.faixas[0], w3, D, await mais(pool, D, 5));
    esperaExcedeu(await erroDe(upd('UPDATE patient_itinerary_assignment SET valid_to = $1::date WHERE id = $2', [await mais(pool, D, 15), a3])));
  });

  it('Trava A positivos: encerrar numa faixa já acima do limite é aceito', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await travaA(c, false);
      await alocar(c, cen.faixas[0], w1, D, null);
      await alocar(c, cen.faixas[0], w2, D, null);
      const a3 = await alocar(c, cen.faixas[0], w3, D, null);
      await travaA(c, true);
      await c.query(`UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = $1::date WHERE id = $2`, [D, a3]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });

  it('Trava A positivos: alocação retroativa é julgada só de hoje em diante', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const ws = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    for (let i = 0; i < 3; i++) await alocar(pool, cen.faixas[0], ws[i], await mais(pool, D, -30), await mais(pool, D, -1));
    await alocar(pool, cen.faixas[0], ws[3], await mais(pool, D, -10), await mais(pool, D, 5));
  });

  it('Trava A positivos: NULL não recusa', async () => {
    const cen = await criarCenario(pool, { providersNeeded: null, faixas: 2 });
    const D = await hojeOp(pool);
    for (let i = 0; i < 3; i++) await alocar(pool, cen.faixas[0], await criarCandidato(pool, cen), D, null);
  });

  it('Trava A positivos: status diferente de ACTIVE sai cedo', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3, w4] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, null);
    await alocar(pool, cen.faixas[0], w2, D, null);
    await alocar(pool, cen.faixas[0], w3, D, null, 'CANCELLED');
    await alocar(pool, cen.faixas[0], w4, D, await mais(pool, D, 3), 'ENDED');
  });

  it('Trava A positivos: substituto de um dia não conta', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    const a1 = await alocar(pool, cen.faixas[0], w1, D, null);
    await pool.query(
      `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
       VALUES ($1, $2::date, $3, $4, 'qa058b', 'qa058b')`,
      [a1, await proximaSegunda(D), w2.workerId, w2.applicationId]);
    await alocar(pool, cen.faixas[0], w3, D, null); // ocupação = W1 + W3 = 2; contando o substituto seria 3
  });

  it('Trava A positivos: troca de titular concorrente (2 conexões reais) sem deadlock', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 1, faixas: 2 });
    const D = await hojeOp(pool);
    const D1 = await mais(pool, D, 1);
    const [w1, w2, w3, w4] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    const a1 = await alocar(pool, cen.faixas[0], w1, D, null);
    const a3 = await alocar(pool, cen.faixas[1], w3, D, null);
    const a: PoolClient = await pool.connect();
    const b: PoolClient = await pool.connect();
    try {
      expect(a).not.toBe(b);
      await a.query('BEGIN');
      await b.query('BEGIN');
      const troca = async (c: PoolClient, velha: string, faixa: string, novo: typeof w2): Promise<void> => {
        await c.query(`UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = $1::date WHERE id = $2`, [D, velha]);
        await alocar(c, faixa, novo, D1, null);
      };
      const rs = await Promise.allSettled([troca(a, a1, cen.faixas[0], w2), troca(b, a3, cen.faixas[1], w4)]);
      for (const r of rs) {
        if (r.status === 'rejected') expect((r.reason as { code?: string }).code).not.toBe('40P01');
        expect(r.status).toBe('fulfilled');
      }
      await a.query('COMMIT');
      await b.query('COMMIT');
    } catch (e) {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      a.release();
      b.release();
    }
    for (const f of cen.faixas) {
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_itinerary_assignment WHERE slot_id = $1 AND status = 'ACTIVE' AND valid_to IS NULL`, [f]);
      expect(r.rows[0].n).toBe(1);
    }
  });

  it('corrida: 2 transações reais na última vaga da faixa — a 1ª fica aberta sem COMMIT, a 2ª espera o lock do serviço, exatamente 1 passa', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const [w1, w2, w3] = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    await alocar(pool, cen.faixas[0], w1, D, null);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await alocar(a, cen.faixas[0], w2, D, null); // segura o lock do serviço até o COMMIT
      await b.query('BEGIN');
      let terminou = false;
      const pb = erroDe(() => alocar(b, cen.faixas[0], w3, D, null)).then((e) => { terminou = true; return e; });
      await new Promise((r) => setTimeout(r, 400));
      expect(terminou).toBe(false); // prova de que a 2ª estava de fato bloqueada no lock, não só atrasada
      await a.query('COMMIT');
      esperaExcedeu(await pb);
      await b.query('ROLLBACK');
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_itinerary_assignment WHERE slot_id = $1 AND status = 'ACTIVE'`, [cen.faixas[0]]);
      expect(r.rows[0].n).toBe(2);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  const sql543 = (): string => fs.readFileSync(path.join(__dirname, '../../migrations/543_058b_trava_a_capacidade_da_faixa.sql'), 'utf8');

  it('assert 12a levanta: faixa acima do limite faz a migration 543 falhar', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    const ws = [await criarCandidato(pool, cen), await criarCandidato(pool, cen), await criarCandidato(pool, cen)];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await travaA(c, false);
      for (const w of ws) await alocar(c, cen.faixas[0], w, D, null);
      await travaA(c, true);
      const sql = sql543();
      const e = await erroDe(() => c.query(sql));
      expect(e?.code).toBe('P0001');
      expect(e?.message).toContain('TRAVA_A_ATIVACAO_RECUSADA');
      expect(e?.message).toContain('1 faixa(s)');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('assert 12a avisa: banco sem faixa acima passa e o NOTICE diz quantas faixas foram avaliadas', async () => {
    const cen = await criarCenario(pool, { providersNeeded: 2, faixas: 2 });
    const D = await hojeOp(pool);
    await alocar(pool, cen.faixas[0], await criarCandidato(pool, cen), D, null);
    const avisos: string[] = [];
    const c = await pool.connect();
    c.on('notice', (m) => { avisos.push(m.message ?? ''); });
    try {
      await c.query('BEGIN');
      await c.query(sql543());
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    const m = avisos.map((x) => /^faixas_avaliadas=(\d+), faixas_acima=0$/.exec(x)).find((x) => x);
    expect(m).toBeTruthy();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(1); // zero avaliada seria "não medi"
  });
});
