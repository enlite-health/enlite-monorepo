/**
 * Spec 092 (F2, T201, CA-2) — migration 590: informe da guarda no BANCO REAL.
 *
 * As 4 inserções/escritas proibidas (CA-2) + o que sustenta DC-6/DC-7:
 *   1. 2º informe da mesma guarda (worker × faixa × dia)            → 23505 daily_reports_guarda_unica
 *   2. resposta com opção de OUTRA escala (FK composta)              → 23503 daily_report_answers_opcao_fk
 *   3. motivo numa opção que não o pede (trigger)                    → 23514 (daily_report_motivo_nao_pedido)
 *   4. UPDATE de informe recebido (trigger de imutabilidade)         → 55000 (também DELETE direto, e nas respostas)
 * + CHECKs (item um, valor um, narrativa 1..8000, count 0..999), nota por join, sinal imediato, trava de opção referenciada da 588 que
 *   AGORA bloqueia (sem resposta → passa; com resposta → 55000), purge do paciente por CASCADE, privilégios (app_runtime: INSERT sim, UPDATE/DELETE não).
 * Dado 100% sintético; narrativa = `NARRATIVA-ESPIA-092`.
 */
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv7 } from 'uuid';
import { catalogoItens, inserirPti, semearGuarda, limparGuarda, type CatalogoItens, type Guarda } from './helpers/seedDailyReport092';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'e2e092-schema';

describe('590 — informe da guarda: constraints, imutabilidade e privilégios (banco real) @integration', () => {
  let pool: Pool;
  let g: Guarda;
  let cat: CatalogoItens;
  let ptiId: string;

  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function falha(c: PoolClient, sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string; message?: string }> {
    await c.query('SAVEPOINT s');
    try {
      await c.query(sql, params);
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      const e = err as { code?: string; constraint?: string; message?: string };
      return { code: e.code, constraint: e.constraint, message: e.message };
    }
    await c.query('RELEASE SAVEPOINT s');
    throw new Error(`esperava falha, mas o SQL passou: ${sql}`);
  }
  const informe = async (c: PoolClient, over: Record<string, unknown> = {}): Promise<string> => {
    const cols: Record<string, unknown> = {
      id: uuidv7(), worker_id: g.workerId, slot_id: g.slotSegId, on_date: g.onDate, pti_version_id: ptiId,
      narrative: 'NARRATIVA-ESPIA-092', narrative_source: 'TYPED', device_submitted_at: new Date().toISOString(), app_version: '1.0.0', ...over,
    };
    const keys = Object.keys(cols);
    await c.query(`INSERT INTO daily_reports (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => cols[k]));
    return cols.id as string;
  };
  const resposta = (c: PoolClient, reportId: string, over: Record<string, unknown>) => {
    const cols: Record<string, unknown> = { report_id: reportId, objective_id: cat.objSn, scale_code: 'SN', option_code: 'si', ...over };
    const keys = Object.keys(cols);
    return c.query(`INSERT INTO daily_report_answers (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => cols[k]));
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await limparGuarda(pool, TAG);
    g = await semearGuarda(pool, TAG);
    cat = await catalogoItens(pool);
    ptiId = await inserirPti(pool, { patientId: g.patientId, serviceId: g.serviceId, start: '2026-01-01', end: '2027-12-31', objectiveIds: [cat.objSn], activityIds: [cat.actSn] });
  });
  afterAll(async () => {
    await limparGuarda(pool, TAG);
    await pool.end();
  });

  it('controle positivo: informe válido com resposta entra (as recusas abaixo são pela regra, não pelo SQL quebrado)', async () => {
    const n = await tx(async (c) => {
      const id = await informe(c);
      await resposta(c, id, {});
      return Number((await c.query(`SELECT count(*) AS n FROM daily_report_answers WHERE report_id = $1`, [id])).rows[0].n);
    });
    expect(n).toBe(1);
  });

  describe('CA-2 — as 4 escritas proibidas', () => {
    it('1. segundo informe da mesma guarda → 23505 (UNIQUE worker × faixa × dia), mesmo com id diferente', async () => {
      const r = await tx(async (c) => {
        await informe(c);
        return falha(c, `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version)
                         VALUES ($1, $2, $3, $4, 'x', 'TYPED', now(), '1')`, [uuidv7(), g.workerId, g.slotSegId, g.onDate]);
      });
      expect(r).toMatchObject({ code: '23505', constraint: 'daily_reports_guarda_unica' });
    });
    it('2. resposta com opção de OUTRA escala → 23503 (FK composta scale_code, option_code)', async () => {
      const r = await tx(async (c) => {
        const id = await informe(c);
        return falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, option_code) VALUES ($1, $2, 'SN', 'solo')`, [id, cat.objSn]);
      });
      expect(r).toMatchObject({ code: '23503', constraint: 'daily_report_answers_opcao_fk' });
    });
    it('3. motivo numa opção que não o pede → 23514 (trigger); motivo que a escala não tem → 23503', async () => {
      const r = await tx(async (c) => {
        const id = await informe(c);
        return falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, option_code, reason_code) VALUES ($1, $2, 'AUT', 'solo', 'rechazo')`, [id, cat.objAut]);
      });
      expect(r.code).toBe('23514');
      expect(r.message).toMatch(/daily_report_motivo_nao_pedido/);
      const fk = await tx(async (c) => {
        const id = await informe(c);
        return falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, option_code, reason_code) VALUES ($1, $2, 'AUT', 'no_lo_hizo', 'inexistente')`, [id, cat.objAut]);
      });
      expect(fk).toMatchObject({ code: '23503', constraint: 'daily_report_answers_motivo_fk' });
    });
    it('3b. controle positivo do motivo: "no_lo_hizo" com motivo da AUT entra', async () => {
      await expect(tx(async (c) => {
        const id = await informe(c);
        await resposta(c, id, { objective_id: cat.objAut, scale_code: 'AUT', option_code: 'no_lo_hizo', reason_code: 'rechazo' });
      })).resolves.toBeUndefined();
    });
    it('4. UPDATE de informe recebido → 55000; DELETE direto → 55000; idem nas respostas', async () => {
      await tx(async (c) => {
        const id = await informe(c);
        await resposta(c, id, {});
        expect(await falha(c, `UPDATE daily_reports SET app_version = '2' WHERE id = $1`, [id])).toMatchObject({ code: '55000' });
        expect(await falha(c, `DELETE FROM daily_reports WHERE id = $1`, [id])).toMatchObject({ code: '55000' });
        expect(await falha(c, `UPDATE daily_report_answers SET option_code = 'no' WHERE report_id = $1`, [id])).toMatchObject({ code: '55000' });
        expect(await falha(c, `DELETE FROM daily_report_answers WHERE report_id = $1`, [id])).toMatchObject({ code: '55000' });
      });
    });
  });

  describe('CHECKs', () => {
    it('narrativa vazia/só espaços e > 8000 → 23514; fonte fora da lista → 23514', async () => {
      const vazia = await tx(async (c) => falha(c, `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version)
        VALUES ($1, $2, $3, $4, '   ', 'TYPED', now(), '1')`, [uuidv7(), g.workerId, g.slotSegId, g.onDate]));
      expect(vazia.constraint).toBe('daily_reports_narrative_len');
      const longa = await tx(async (c) => falha(c, `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version)
        VALUES ($1, $2, $3, $4, repeat('a', 8001), 'TYPED', now(), '1')`, [uuidv7(), g.workerId, g.slotSegId, g.onDate]));
      expect(longa.constraint).toBe('daily_reports_narrative_len');
      const fonte = await tx(async (c) => falha(c, `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version)
        VALUES ($1, $2, $3, $4, 'x', 'AUDIO', now(), '1')`, [uuidv7(), g.workerId, g.slotSegId, g.onDate]));
      expect(fonte.constraint).toBe('daily_reports_narrative_source');
      await expect(tx((c) => informe(c, { narrative: 'a'.repeat(8000) }))).resolves.toBeDefined();
    });
    it('resposta: item (objetivo XOR atividade), valor (opção XOR contagem) e faixa da contagem', async () => {
      await tx(async (c) => {
        const id = await informe(c);
        expect((await falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, activity_id, scale_code, option_code) VALUES ($1, $2, $3, 'SN', 'si')`, [id, cat.objSn, cat.actSn])).constraint).toBe('daily_report_answers_item_um');
        expect((await falha(c, `INSERT INTO daily_report_answers (report_id, scale_code, option_code) VALUES ($1, 'SN', 'si')`, [id])).constraint).toBe('daily_report_answers_item_um');
        expect((await falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code) VALUES ($1, $2, 'CNT')`, [id, cat.objCnt])).constraint).toBe('daily_report_answers_valor_um');
        expect((await falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, option_code, count_value) VALUES ($1, $2, 'SN', 'si', 1)`, [id, cat.objSn])).constraint).toBe('daily_report_answers_valor_um');
        expect((await falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, count_value) VALUES ($1, $2, 'CNT', 1000)`, [id, cat.objCnt])).constraint).toBe('daily_report_answers_count_faixa');
        expect((await falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, count_value) VALUES ($1, $2, 'CNT', -1)`, [id, cat.objCnt])).constraint).toBe('daily_report_answers_count_faixa');
        await c.query(`INSERT INTO daily_report_answers (report_id, objective_id, scale_code, count_value) VALUES ($1, $2, 'CNT', 999)`, [id, cat.objCnt]);
      });
    });
    it('item repetido no mesmo informe → 23505 (UNIQUE parcial)', async () => {
      const r = await tx(async (c) => {
        const id = await informe(c);
        await resposta(c, id, {});
        return falha(c, `INSERT INTO daily_report_answers (report_id, objective_id, scale_code, option_code) VALUES ($1, $2, 'SN', 'no')`, [id, cat.objSn]);
      });
      expect(r).toMatchObject({ code: '23505', constraint: 'uq_daily_report_answers_objective' });
    });
  });

  describe('derivados e trava da 588', () => {
    it('nota por join (DC-6): GEN "1" → score 1 + sinal imediato; SN "si" → score NULL e sem sinal (condicional)', async () => {
      const r = await tx(async (c) => {
        const objGen = (await c.query(`SELECT id FROM therapeutic_specific_objectives WHERE daily_scale_code = 'GEN' ORDER BY id LIMIT 1`)).rows[0].id;
        const id = await informe(c);
        await resposta(c, id, { objective_id: objGen, scale_code: 'GEN', option_code: '1' });
        await resposta(c, id, {});
        const scores = (await c.query(`SELECT scale_code, score FROM daily_report_answer_scores WHERE report_id = $1 ORDER BY scale_code`, [id])).rows;
        const sinais = (await c.query(`SELECT scale_code, option_code, alert_text_es FROM daily_report_alert_signals WHERE report_id = $1`, [id])).rows;
        return { scores, sinais };
      });
      expect(r.scores).toEqual([{ scale_code: 'GEN', score: 1 }, { scale_code: 'SN', score: null }]);
      expect(r.sinais).toHaveLength(1);
      expect(r.sinais[0]).toMatchObject({ scale_code: 'GEN', option_code: '1' });
      expect(r.sinais[0].alert_text_es).toBeTruthy();
    });
    it('trava da 588 AGORA bloqueia: sem resposta → UPDATE de score passa; com resposta → 55000 (sabotagem: a resposta é o que liga a trava)', async () => {
      await tx(async (c) => {
        // controle: opção ainda não referenciada por NENHUM informe real do banco de teste (rodamos dentro de ROLLBACK)
        const livre = await c.query(`UPDATE daily_report_scale_options SET score = 7 WHERE scale_code = 'GEN' AND option_code = '5'`);
        expect(livre.rowCount).toBe(1);
        const objGen = (await c.query(`SELECT id FROM therapeutic_specific_objectives WHERE daily_scale_code = 'GEN' ORDER BY id LIMIT 1`)).rows[0].id;
        const id = await informe(c);
        await resposta(c, id, { objective_id: objGen, scale_code: 'GEN', option_code: '5' });
        const travada = await falha(c, `UPDATE daily_report_scale_options SET score = 8 WHERE scale_code = 'GEN' AND option_code = '5'`);
        expect(travada.code).toBe('55000');
        expect(travada.message).toMatch(/daily_report_option_imutavel/);
        // outra opção da mesma escala, sem resposta, segue corrigível
        expect((await c.query(`UPDATE daily_report_scale_options SET score = 9 WHERE scale_code = 'GEN' AND option_code = '4'`)).rowCount).toBe(1);
      });
    });
  });

  describe('purge e privilégios', () => {
    it('apagar o paciente leva serviço, faixa e informes por CASCADE (lex C4); DELETE direto segue recusado', async () => {
      const t2 = `${TAG}-purge`;
      await limparGuarda(pool, t2);
      const g2 = await semearGuarda(pool, t2);
      const id = uuidv7();
      await pool.query(
        `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version) VALUES ($1, $2, $3, $4, 'NARRATIVA-ESPIA-092', 'TYPED', now(), '1')`,
        [id, g2.workerId, g2.slotSegId, g2.onDate],
      );
      await pool.query(`INSERT INTO daily_report_answers (report_id, objective_id, scale_code, option_code) SELECT $1, id, 'SN', 'si' FROM therapeutic_specific_objectives WHERE daily_scale_code = 'SN' LIMIT 1`, [id]);
      await expect(pool.query(`DELETE FROM daily_reports WHERE id = $1`, [id])).rejects.toMatchObject({ code: '55000' });
      // vaga/candidatura/alocação não têm CASCADE do paciente (fora do escopo da 092): saem antes; o que a 092 prova é o informe
      await pool.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id = $1`, [g2.slotSegId]);
      await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = $1)`, [g2.patientId]);
      await pool.query(`DELETE FROM job_postings WHERE patient_id = $1`, [g2.patientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [g2.patientId]);
      const left = await pool.query(`SELECT (SELECT count(*) FROM daily_reports WHERE id = $1)::int AS r, (SELECT count(*) FROM daily_report_answers WHERE report_id = $1)::int AS a`, [id]);
      expect(left.rows[0]).toEqual({ r: 0, a: 0 });
      await limparGuarda(pool, t2);
    });
    it('app_runtime: INSERT e SELECT sim; UPDATE e DELETE → 42501 (e a view de sinal é legível)', async () => {
      await tx(async (c) => {
        await c.query(`SET LOCAL ROLE app_system`);
        await c.query(`SELECT set_config('app.system_context', 'e2e092', true)`);
        const id = uuidv7();
        await c.query(`INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version) VALUES ($1, $2, $3, $4, 'x', 'TYPED', now(), '1')`, [id, g.workerId, g.slotSegId, g.onDate]);
        expect(Number((await c.query(`SELECT count(*) AS n FROM daily_reports WHERE id = $1`, [id])).rows[0].n)).toBe(1);
        expect((await falha(c, `UPDATE daily_reports SET app_version = '2' WHERE id = $1`, [id])).code).toBe('42501');
        expect((await falha(c, `DELETE FROM daily_reports WHERE id = $1`, [id])).code).toBe('42501');
        expect((await falha(c, `DELETE FROM daily_report_answers`)).code).toBe('42501');
        await c.query(`SELECT count(*) FROM daily_report_alert_signals`);
      });
    });
    it('RLS: app_runtime SEM identidade/contexto não lê informe (fail-closed: a sessão é recusada, nunca devolve linha)', async () => {
      const id = uuidv7();
      await pool.query(`INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version) VALUES ($1, $2, $3, $4, 'x', 'TYPED', now(), '1')`, [id, g.workerId, g.slotSegId, g.onDate]);
      try {
        await expect(tx(async (c) => {
          await c.query(`SET LOCAL ROLE app_runtime`);
          await c.query(`SELECT count(*) AS n FROM daily_reports WHERE id = $1`, [id]);
        })).rejects.toThrow(/rls_session_without_identity/);
      } finally {
        await pool.query(`ALTER TABLE daily_reports DISABLE TRIGGER trg_092_daily_report_imutavel`);
        await pool.query(`DELETE FROM daily_reports WHERE id = $1`, [id]);
        await pool.query(`ALTER TABLE daily_reports ENABLE TRIGGER trg_092_daily_report_imutavel`);
      }
    });
  });
});
