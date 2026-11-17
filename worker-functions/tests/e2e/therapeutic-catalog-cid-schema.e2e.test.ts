/**
 * Spec 091 (F1, T103, CA-2) — migration 586: catálogo terapêutico por CID-11 e serviço, no BANCO REAL.
 *
 * Invariantes provadas aqui (todas no banco, nenhuma no código):
 *   1. seed 415 inativo (updated_by 'migration:586') e `therapeutic_segments` com 0 ativo (DF-1, DF-3);
 *   2. vínculo de atividade em categoria fora do objetivo → 23503 (FK composta, DD-2);
 *   3. item ativo sem dono → 23514 (DD-15);
 *   4. UPDATE em `diagnosis_plans` → 55000 (trigger de imutabilidade, DD-5);
 *   5. formato misto do PTI → 23514 (DD-7); bloco com URI fora da ordem de `diagnoses` → 23514;
 *   6. trocar o objetivo da atividade propaga ao vínculo (objetivo com as categorias) ou 23503 (sem elas);
 *   7. 2º objetivo ativo com mesmo (serviço, título, descrição) → 23505 em `…_label_ativo` (DD-3);
 *      mesmo texto de atividade sob outro objetivo → aceito;
 *   8. `app_runtime` grava vínculo só com SELECT/INSERT/DELETE (SET ROLE dentro da transação).
 *
 * Só dado sintético (rótulos "e2e-091 …", paciente sintético). Cada caso roda numa transação desfeita (ROLLBACK),
 * exceto os que precisam de commit para o trigger de imutabilidade; esses limpam no `afterAll`.
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PATIENT = 'ee091000-0a00-0001-0001-000000000001';
const URI_A = 'http://id.who.int/icd/entity/e2e091-a';
const URI_B = 'http://id.who.int/icd/entity/e2e091-b';

describe('586 — catálogo terapêutico por CID e serviço (banco real) @integration', () => {
  let pool: Pool;
  let serviceId: string;

  /** Roda `fn` numa transação e sempre desfaz. */
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

  /** Executa um SQL esperando falha; devolve `{code, constraint}`. Usa SAVEPOINT para não abortar a transação. */
  async function falha(c: PoolClient, sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string }> {
    await c.query('SAVEPOINT s');
    try {
      await c.query(sql, params);
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      const e = err as { code?: string; constraint?: string };
      return { code: e.code, constraint: e.constraint };
    }
    await c.query('RELEASE SAVEPOINT s');
    throw new Error(`esperava falha, mas o SQL passou: ${sql}`);
  }

  const novoObjetivo = async (c: PoolClient, label: string, o: { service?: string | null; description?: string | null; active?: boolean } = {}): Promise<string> => {
    const active = o.active ?? true;
    const r = await c.query<{ id: string }>(
      `INSERT INTO therapeutic_specific_objectives (label, description, service_code, active, deactivated_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NULL ELSE NOW() END, 'e2e-091', 'e2e-091') RETURNING id`,
      [label, o.description ?? null, o.service === undefined ? 'CAREGIVER' : o.service, active],
    );
    return r.rows[0].id;
  };
  const novaAtividade = async (c: PoolClient, label: string, objectiveId: string | null, active = true): Promise<string> => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO therapeutic_activities (label, objective_id, active, deactivated_at, created_by, updated_by)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN NULL ELSE NOW() END, 'e2e-091', 'e2e-091') RETURNING id`,
      [label, objectiveId, active],
    );
    return r.rows[0].id;
  };
  const vincObjetivo = (c: PoolClient, objectiveId: string, code: string) =>
    c.query(`INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, created_by) VALUES ($1, $2, 'e2e-091')`, [objectiveId, code]);
  const vincAtividade = (c: PoolClient, activityId: string, objectiveId: string, code: string) =>
    c.query(
      `INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ($1, $2, $3, 'e2e-091')`,
      [activityId, objectiveId, code],
    );

  const diagnoses = JSON.stringify([{ uri: URI_A, code: '6A02', title: 'Sintético A' }, { uri: URI_B, code: '6A05', title: 'Sintético B' }]);
  const plan = (uri: string) => ({ diagnosisUri: uri, categoryCode: '6A02', objectives: [], activities: [] });

  const insertPti = (c: PoolClient, over: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      patient_id: PATIENT,
      major: 1,
      minor: 0,
      contracted_service_id: serviceId,
      diagnoses,
      clinical_context: 'contexto sintético e2e',
      general_objective: 'objetivo sintético e2e',
      specific_objectives: '[]',
      activities: '[]',
      pathology_types: JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label: 'pat' }]),
      start_date: '2026-09-01',
      end_date: '2026-12-31',
      created_by: 'e2e-091-uid',
      diagnosis_plans: JSON.stringify([plan(URI_A), plan(URI_B)]),
      ...over,
    };
    const keys = Object.keys(cols);
    return c.query<{ id: string }>(
      `INSERT INTO patient_therapeutic_projects (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => cols[k]),
    );
  };

  const cleanup = async (): Promise<void> => {
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await cleanup();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, 'e2e-091-a', 'Paciente', 'Sintético', 'AR')`,
      [PATIENT],
    );
    const s = await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'e2e-091-uid', 'e2e-091-uid') RETURNING id`,
      [PATIENT],
    );
    serviceId = s.rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('seed 415 inativo e therapeutic_segments com 0 ativo (DF-1, DF-3)', async () => {
    const seed = await pool.query<{ ativos: string; total: string; marcados: string }>(
      `SELECT count(*) FILTER (WHERE active) AS ativos, count(*) AS total,
              count(*) FILTER (WHERE updated_by = 'migration:586') AS marcados
         FROM (SELECT active, created_by, updated_by FROM therapeutic_specific_objectives
               UNION ALL SELECT active, created_by, updated_by FROM therapeutic_activities) t
        WHERE created_by = 'seed:415'`,
    );
    expect(Number(seed.rows[0].total)).toBeGreaterThan(0); // a medição acharia algo se houvesse
    expect(Number(seed.rows[0].ativos)).toBe(0);
    expect(Number(seed.rows[0].marcados)).toBe(Number(seed.rows[0].total));
    const seg = await pool.query<{ ativos: string; total: string }>(
      `SELECT count(*) FILTER (WHERE active) AS ativos, count(*) AS total FROM therapeutic_segments`,
    );
    expect(Number(seg.rows[0].total)).toBeGreaterThan(0);
    expect(Number(seg.rows[0].ativos)).toBe(0);
  });

  it('vínculo de atividade em categoria fora do objetivo → 23503', () =>
    tx(async (c) => {
      const o = await novoObjetivo(c, 'e2e-091 obj fora');
      await vincObjetivo(c, o, '6A02');
      const a = await novaAtividade(c, 'e2e-091 ativ fora', o);
      await vincAtividade(c, a, o, '6A02'); // dentro: passa
      const r = await falha(c, `INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ($1, $2, '6A05', 'e2e-091')`, [a, o]);
      expect(r.code).toBe('23503');
      expect(r.constraint).toBe('therapeutic_activity_icd_categories_dentro_do_objetivo_fk');
    }));

  it('vínculo com objective_id divergente do da atividade → 23503 (atividade_fk)', () =>
    tx(async (c) => {
      const o1 = await novoObjetivo(c, 'e2e-091 obj 1');
      const o2 = await novoObjetivo(c, 'e2e-091 obj 2');
      await vincObjetivo(c, o2, '6A02');
      const a = await novaAtividade(c, 'e2e-091 ativ', o1);
      const r = await falha(c, `INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ($1, $2, '6A02', 'e2e-091')`, [a, o2]);
      expect(r.code).toBe('23503');
      expect(r.constraint).toBe('therapeutic_activity_icd_categories_atividade_fk');
    }));

  it('item ativo sem dono → 23514 (objetivo sem serviço, atividade sem objetivo)', () =>
    tx(async (c) => {
      const o = await falha(
        c,
        `INSERT INTO therapeutic_specific_objectives (label, service_code, created_by, updated_by) VALUES ('e2e-091 sem dono', NULL, 'e2e-091', 'e2e-091')`,
      );
      expect(o).toEqual({ code: '23514', constraint: 'therapeutic_specific_objectives_ativo_tem_servico' });
      const a = await falha(c, `INSERT INTO therapeutic_activities (label, objective_id, created_by, updated_by) VALUES ('e2e-091 sem dono', NULL, 'e2e-091', 'e2e-091')`);
      expect(a).toEqual({ code: '23514', constraint: 'therapeutic_activities_ativa_tem_objetivo' });
    }));

  it('reativar item antigo (seed 415) sem dono → 23514', () =>
    tx(async (c) => {
      const r = await falha(c, `UPDATE therapeutic_specific_objectives SET active = true, deactivated_at = NULL WHERE created_by = 'seed:415'`);
      expect(r.code).toBe('23514');
    }));

  it('frequência sugerida vazia ou > 100 → 23514', () =>
    tx(async (c) => {
      const o = await novoObjetivo(c, 'e2e-091 obj freq');
      const a = await novaAtividade(c, 'e2e-091 ativ freq', o);
      for (const v of ['   ', 'x'.repeat(101)]) {
        const r = await falha(c, `UPDATE therapeutic_activities SET suggested_frequency = $2 WHERE id = $1`, [a, v]);
        expect(r.constraint).toBe('therapeutic_activities_suggested_frequency_len');
      }
      await c.query(`UPDATE therapeutic_activities SET suggested_frequency = '3x por semana' WHERE id = $1`, [a]);
    }));

  describe('versão do PTI (formato exclusivo, imutabilidade)', () => {
    afterEach(async () => {
      // a trigger só deixa apagar quando o paciente some; recria o paciente e o serviço para o próximo caso
      await cleanup();
      await pool.query(
        `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, 'e2e-091-a', 'Paciente', 'Sintético', 'AR')`,
        [PATIENT],
      );
      const s = await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
         VALUES ($1, 'CAREGIVER', 'e2e-091-uid', 'e2e-091-uid') RETURNING id`,
        [PATIENT],
      );
      serviceId = s.rows[0].id;
    });

    it('formato novo válido entra (prova que os CHECKs ≥1 antigos foram derrubados)', () =>
      tx(async (c) => {
        const r = await insertPti(c);
        expect(r.rows[0].id).toBeTruthy();
      }));

    it('formato antigo (diagnosis_plans NULL + listas ≥1) entra', () =>
      tx(async (c) => {
        const um = JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label: 'x' }]);
        const r = await insertPti(c, { diagnosis_plans: null, specific_objectives: um, activities: um });
        expect(r.rows[0].id).toBeTruthy();
      }));

    it('formato misto → 23514 (3 combinações)', () =>
      tx(async (c) => {
        const um = JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label: 'x' }]);
        const casos: Record<string, unknown>[] = [
          { specific_objectives: um }, // novo com lista plana preenchida
          { activities: um },
          { diagnosis_plans: null }, // antigo com listas planas vazias
          { diagnosis_plans: JSON.stringify([plan(URI_A)]) }, // tamanho diferente de `diagnoses`
        ];
        for (const over of casos) {
          const sql = Object.keys(over).length; // só para falhar alto se o caso vier vazio
          expect(sql).toBeGreaterThan(0);
          await c.query('SAVEPOINT m');
          await expect(insertPti(c, over)).rejects.toMatchObject({ code: '23514' });
          await c.query('ROLLBACK TO SAVEPOINT m');
        }
      }));

    it('bloco com URI fora da ordem de `diagnoses` → 23514 (ptp_diagnosis_plans_forma)', () =>
      tx(async (c) => {
        await c.query('SAVEPOINT m');
        await expect(insertPti(c, { diagnosis_plans: JSON.stringify([plan(URI_B), plan(URI_A)]) })).rejects.toMatchObject({
          code: '23514',
          constraint: 'ptp_diagnosis_plans_forma',
        });
        await c.query('ROLLBACK TO SAVEPOINT m');
        // bloco malformado (sem `activities`; categoryCode numérico) também cai
        for (const ruim of [
          [{ diagnosisUri: URI_A, categoryCode: null, objectives: [] }, plan(URI_B)],
          [{ ...plan(URI_A), categoryCode: 5 }, plan(URI_B)],
          [{ diagnosisUri: URI_A, objectives: [], activities: [] }, plan(URI_B)],
        ]) {
          await c.query('SAVEPOINT m');
          await expect(insertPti(c, { diagnosis_plans: JSON.stringify(ruim) })).rejects.toMatchObject({ constraint: 'ptp_diagnosis_plans_forma' });
          await c.query('ROLLBACK TO SAVEPOINT m');
        }
        // categoryCode null é aceito
        await insertPti(c, { diagnosis_plans: JSON.stringify([{ ...plan(URI_A), categoryCode: null }, plan(URI_B)]) });
      }));

    it('UPDATE em diagnosis_plans → 55000 (imutável)', async () => {
      const ins = await insertPti(pool as unknown as PoolClient);
      const id = ins.rows[0].id;
      await expect(
        pool.query(`UPDATE patient_therapeutic_projects SET diagnosis_plans = $2 WHERE id = $1`, [id, JSON.stringify([{ ...plan(URI_A), categoryCode: '6A05' }, plan(URI_B)])]),
      ).rejects.toMatchObject({ code: '55000' });
      // controle do controle: a anulação (única escrita permitida) passa
      await pool.query(`UPDATE patient_therapeutic_projects SET annulled_at = NOW(), annulled_by = 'e2e', annul_reason = 'e2e' WHERE id = $1`, [id]);
    });
  });

  it('trocar o objetivo da atividade: com as categorias propaga ao vínculo; sem elas → 23503', () =>
    tx(async (c) => {
      const o1 = await novoObjetivo(c, 'e2e-091 troca 1');
      const o2 = await novoObjetivo(c, 'e2e-091 troca 2');
      const o3 = await novoObjetivo(c, 'e2e-091 troca 3');
      for (const o of [o1, o2]) await vincObjetivo(c, o, '6A02');
      await vincObjetivo(c, o3, '6A05'); // não tem a 6A02
      const a = await novaAtividade(c, 'e2e-091 ativ troca', o1);
      await vincAtividade(c, a, o1, '6A02');

      await c.query(`UPDATE therapeutic_activities SET objective_id = $2 WHERE id = $1`, [a, o2]);
      const v = await c.query<{ objective_id: string }>(`SELECT objective_id FROM therapeutic_activity_icd_categories WHERE activity_id = $1`, [a]);
      expect(v.rows).toEqual([{ objective_id: o2 }]);

      const r = await falha(c, `UPDATE therapeutic_activities SET objective_id = $2 WHERE id = $1`, [a, o3]);
      expect(r.code).toBe('23503');
    }));

  it('remover a categoria do objetivo leva o vínculo das atividades dele (ON DELETE CASCADE)', () =>
    tx(async (c) => {
      const o = await novoObjetivo(c, 'e2e-091 cascade');
      await vincObjetivo(c, o, '6A02');
      const a = await novaAtividade(c, 'e2e-091 ativ cascade', o);
      await vincAtividade(c, a, o, '6A02');
      await c.query(`DELETE FROM therapeutic_objective_icd_categories WHERE objective_id = $1 AND category_code = '6A02'`, [o]);
      const v = await c.query(`SELECT 1 FROM therapeutic_activity_icd_categories WHERE activity_id = $1`, [a]);
      expect(v.rowCount).toBe(0);
    }));

  it('2º objetivo ativo com mesmo (serviço, título, descrição) → 23505 em …_label_ativo; outro serviço ou inativo passa', () =>
    tx(async (c) => {
      await novoObjetivo(c, 'e2e-091 Dup', { description: 'Desc' });
      const r = await falha(
        c,
        `INSERT INTO therapeutic_specific_objectives (label, description, service_code, created_by, updated_by)
         VALUES ('  E2E-091 dup ', ' desc', 'CAREGIVER', 'e2e-091', 'e2e-091')`,
      );
      expect(r.code).toBe('23505');
      expect(r.constraint).toMatch(/_label_ativo$/);
      expect(r.constraint).toBe('uq_therapeutic_specific_objectives_servico_label_ativo');
      await novoObjetivo(c, 'e2e-091 Dup', { description: 'Outra desc' }); // descrição diferente
      await novoObjetivo(c, 'e2e-091 Dup', { description: 'Desc', active: false }); // inativo
      const outro = await c.query<{ code: string }>(`SELECT code FROM service_types WHERE code <> 'CAREGIVER' LIMIT 1`);
      expect(outro.rowCount).toBe(1);
      await novoObjetivo(c, 'e2e-091 Dup', { description: 'Desc', service: outro.rows[0].code }); // outro serviço
    }));

  it('mesmo texto de atividade: repetido sob o mesmo objetivo → 23505 …_label_ativo; sob outro objetivo → aceito', () =>
    tx(async (c) => {
      const o1 = await novoObjetivo(c, 'e2e-091 ativ txt 1');
      const o2 = await novoObjetivo(c, 'e2e-091 ativ txt 2');
      await novaAtividade(c, 'e2e-091 Mesmo texto', o1);
      await novaAtividade(c, 'e2e-091 Mesmo texto', o2); // aceito
      const r = await falha(c, `INSERT INTO therapeutic_activities (label, objective_id, created_by, updated_by) VALUES (' E2E-091 mesmo TEXTO', $1, 'e2e-091', 'e2e-091')`, [o1]);
      expect(r.code).toBe('23505');
      expect(r.constraint).toBe('uq_therapeutic_activities_objetivo_label_ativo');
      expect(r.constraint).toMatch(/_label_ativo$/);
    }));

  it('código de categoria fora de ^[0-9A-Z]{4}$ → 23514', () =>
    tx(async (c) => {
      const o = await novoObjetivo(c, 'e2e-091 formato');
      for (const code of ['6a02', '6A0', '6A022', '6A-2']) {
        const r = await falha(c, `INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, created_by) VALUES ($1, $2, 'e2e-091')`, [o, code]);
        expect(r.constraint).toBe('therapeutic_objective_icd_categories_code_formato');
      }
    }));

  it('INSERT de vínculo como app_runtime (SET ROLE): SELECT/INSERT/DELETE passam', () =>
    tx(async (c) => {
      const o = await novoObjetivo(c, 'e2e-091 runtime');
      const a = await novaAtividade(c, 'e2e-091 ativ runtime', o);
      await c.query('SET LOCAL ROLE app_runtime');
      await vincObjetivo(c, o, '6A02');
      await vincAtividade(c, a, o, '6A02');
      const sel = await c.query(`SELECT 1 FROM therapeutic_activity_icd_categories WHERE activity_id = $1`, [a]);
      expect(sel.rowCount).toBe(1);
      await c.query(`DELETE FROM therapeutic_activity_icd_categories WHERE activity_id = $1`, [a]);
      const apos = await c.query(`SELECT 1 FROM therapeutic_activity_icd_categories WHERE activity_id = $1`, [a]);
      expect(apos.rowCount).toBe(0);
      const prova = await c.query<{ r: string }>(`SELECT current_user AS r`);
      expect(prova.rows[0].r).toBe('app_runtime');
    }));
});
