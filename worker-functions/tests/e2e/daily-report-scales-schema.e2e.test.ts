/**
 * Spec 092 (F1, T101, CA-1/CA-2 parcial) — migration 588: catálogo de escalas do registro diário, no BANCO REAL.
 *
 * Invariantes provadas aqui (todas no banco, nenhuma no código):
 *   1. CHECKs de escala: código fora da lista, answered_by, answer_kind → 23514;
 *   2. opção: par alerta/texto (alert_kind sem texto) e alert_kind fora da lista → 23514; posição repetida → 23505; escala inexistente → 23503;
 *   3. objetivo: pergunta sem escala (e escala sem pergunta) → 23514; escala inexistente → 23503; atividade com escala inexistente → 23503;
 *   4. COMMENT de NULL nas colunas novas (o significado de "vazio" está no banco);
 *   5. opção REFERENCIADA por resposta é imutável (nota e código → 55000); outras colunas e opção sem resposta seguem editáveis (DC-6);
 *   6. role do app (`app_runtime`) lê o catálogo e NÃO escreve (42501).
 *
 * A tabela de respostas só nasce na migration C (F2); o trigger a consulta por to_regclass. Aqui, dentro de uma transação desfeita,
 * a tabela real (se existir) é renomeada e uma mínima (scale_code, option_code) toma o lugar — a prova vale antes e depois da C.
 * Só dado do catálogo (sem paciente). Cada caso roda numa transação desfeita (ROLLBACK).
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('588 — catálogo de escalas do registro diário (banco real) @integration', () => {
  let pool: Pool;

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

  /** Executa um SQL esperando falha; devolve `{code, constraint}`. SAVEPOINT para não abortar a transação. */
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

  const novaEscala = (c: PoolClient, over: Partial<Record<'code' | 'answered_by' | 'answer_kind', string>> = {}) =>
    c.query(
      `INSERT INTO daily_report_scales (code, name_es, purpose_es, answered_by, answer_kind) VALUES ($1, 'n', 'p', $2, $3)`,
      [over.code ?? 'ANI', over.answered_by ?? 'AT', over.answer_kind ?? 'SINGLE_CHOICE'],
    );
  const opcao = (c: PoolClient, over: Record<string, unknown>) => {
    const cols: Record<string, unknown> = {
      scale_code: 'ANI', option_code: 'e2e092', position: 99, label_es: 'l', meaning_es: 'm', ...over,
    };
    const keys = Object.keys(cols);
    return c.query(`INSERT INTO daily_report_scale_options (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => cols[k]));
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  });
  afterAll(async () => { await pool.end(); });

  it('as 3 tabelas existem e o catálogo foi carregado (controle positivo: a medição enxerga algo)', async () => {
    const q = async (sql: string): Promise<number> => Number((await pool.query<{ n: string }>(sql)).rows[0].n);
    expect(await q(`SELECT count(*) AS n FROM daily_report_scales`)).toBeGreaterThan(0);
    expect(await q(`SELECT count(*) AS n FROM daily_report_scale_options`)).toBeGreaterThan(0);
    expect(await q(`SELECT count(*) AS n FROM daily_report_scale_reasons`)).toBeGreaterThan(0);
  });

  describe('CHECKs de escala', () => {
    it('código fora da lista de 18 → 23514', async () => {
      const r = await tx((c) => falha(c, `INSERT INTO daily_report_scales (code, name_es, purpose_es, answered_by, answer_kind) VALUES ('XXX', 'n', 'p', 'AT', 'SINGLE_CHOICE')`));
      expect(r).toEqual({ code: '23514', constraint: 'daily_report_scales_code_lista' });
    });
    it('answered_by e answer_kind fora da lista → 23514', async () => {
      const a = await tx((c) => falha(c, `INSERT INTO daily_report_scales (code, name_es, purpose_es, answered_by, answer_kind) VALUES ('SN', 'n', 'p', 'ROBO', 'SINGLE_CHOICE')`));
      expect(a.constraint).toBe('daily_report_scales_answered_by');
      const k = await tx((c) => falha(c, `INSERT INTO daily_report_scales (code, name_es, purpose_es, answered_by, answer_kind) VALUES ('SN', 'n', 'p', 'AT', 'SLIDER')`));
      expect(k.constraint).toBe('daily_report_scales_answer_kind');
    });
    it('escala repetida → 23505 (as 18 já estão carregadas)', async () => {
      await expect(tx((c) => novaEscala(c))).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('CHECKs e chaves de opção', () => {
    it('alert_kind sem texto → 23514 (par alerta/texto)', async () => {
      const r = await tx((c) => falha(c, `INSERT INTO daily_report_scale_options (scale_code, option_code, position, label_es, meaning_es, alert_kind) VALUES ('ANI', 'e2e092', 99, 'l', 'm', 'IMMEDIATE')`));
      expect(r).toEqual({ code: '23514', constraint: 'daily_report_scale_options_alerta_par' });
    });
    it('texto de aviso sem alert_kind → 23514', async () => {
      const r = await tx((c) => falha(c, `INSERT INTO daily_report_scale_options (scale_code, option_code, position, label_es, meaning_es, alert_text_es) VALUES ('ANI', 'e2e092', 99, 'l', 'm', 'avisa')`));
      expect(r.constraint).toBe('daily_report_scale_options_alerta_par');
    });
    it('alert_kind fora da lista → 23514', async () => {
      const r = await tx((c) => falha(c, `INSERT INTO daily_report_scale_options (scale_code, option_code, position, label_es, meaning_es, alert_kind, alert_text_es) VALUES ('ANI', 'e2e092', 99, 'l', 'm', 'PUSH', 'x')`));
      expect(r.constraint).toBe('daily_report_scale_options_alert_kind');
    });
    it('posição repetida na mesma escala → 23505; escala inexistente → 23503', async () => {
      const pos = await tx((c) => falha(c, `INSERT INTO daily_report_scale_options (scale_code, option_code, position, label_es, meaning_es) VALUES ('ANI', 'e2e092', 1, 'l', 'm')`));
      expect(pos).toEqual({ code: '23505', constraint: 'daily_report_scale_options_position_unica' });
      const fk = await tx((c) => falha(c, `INSERT INTO daily_report_scale_options (scale_code, option_code, position, label_es, meaning_es) VALUES ('NAO', 'e2e092', 99, 'l', 'm')`));
      expect(fk.code).toBe('23503');
    });
    it('opção válida entra (controle: as recusas acima são pela regra, não pelo SQL quebrado)', async () => {
      await expect(tx((c) => opcao(c, {}))).resolves.toBeDefined();
    });
  });

  describe('objetivos e atividades', () => {
    it('pergunta sem escala e escala sem pergunta → 23514', async () => {
      const a = await tx((c) => falha(c, `UPDATE therapeutic_specific_objectives SET daily_question = 'x', daily_scale_code = NULL WHERE id = (SELECT id FROM therapeutic_specific_objectives WHERE active LIMIT 1)`));
      expect(a).toEqual({ code: '23514', constraint: 'therapeutic_specific_objectives_daily_question_scale_par' });
      const b = await tx((c) => falha(c, `UPDATE therapeutic_specific_objectives SET daily_question = NULL, daily_scale_code = 'SN' WHERE id = (SELECT id FROM therapeutic_specific_objectives WHERE active LIMIT 1)`));
      expect(b.constraint).toBe('therapeutic_specific_objectives_daily_question_scale_par');
    });
    it('escala inexistente no objetivo e na atividade → 23503', async () => {
      const o = await tx((c) => falha(c, `UPDATE therapeutic_specific_objectives SET daily_question = 'x', daily_scale_code = 'NAO' WHERE id = (SELECT id FROM therapeutic_specific_objectives WHERE active LIMIT 1)`));
      expect(o.code).toBe('23503');
      const a = await tx((c) => falha(c, `UPDATE therapeutic_activities SET daily_scale_code = 'NAO' WHERE id = (SELECT id FROM therapeutic_activities WHERE active LIMIT 1)`));
      expect(a.code).toBe('23503');
    });
    it('COMMENT das colunas novas diz o que NULL significa', async () => {
      const { rows } = await pool.query<{ col: string; txt: string }>(
        `SELECT c.relname || '.' || a.attname AS col, col_description(c.oid, a.attnum) AS txt
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname IN ('therapeutic_specific_objectives', 'therapeutic_activities', 'daily_report_scale_options')
            AND a.attname IN ('daily_question', 'daily_scale_code', 'operative_indicator', 'score', 'alert_kind')
            AND NOT a.attisdropped`);
      expect(rows.map((r) => r.col).sort()).toEqual([
        'daily_report_scale_options.alert_kind', 'daily_report_scale_options.score',
        'therapeutic_activities.daily_scale_code',
        'therapeutic_specific_objectives.daily_question', 'therapeutic_specific_objectives.daily_scale_code',
        'therapeutic_specific_objectives.operative_indicator']);
      for (const r of rows) expect(r.txt).toMatch(/NULL/);
    });
  });

  describe('opção referenciada por resposta é imutável (DC-6)', () => {
    /** Troca a tabela de respostas (se a F2 já a criou) por uma mínima e referencia ANI/3 e ANI/4 — tudo desfeito no ROLLBACK. */
    const comResposta = async (c: PoolClient): Promise<void> => {
      await c.query(`ALTER TABLE IF EXISTS public.daily_report_answers RENAME TO daily_report_answers_real_bak`);
      await c.query(`CREATE TABLE public.daily_report_answers (scale_code TEXT NOT NULL, option_code TEXT NULL)`);
      await c.query(`INSERT INTO public.daily_report_answers (scale_code, option_code) VALUES ('ANI', '3')`);
    };

    it('UPDATE de score de opção referenciada → 55000; o score não muda', async () => {
      const r = await tx(async (c) => {
        await comResposta(c);
        const f = await falha(c, `UPDATE daily_report_scale_options SET score = 99 WHERE scale_code = 'ANI' AND option_code = '3'`);
        const { rows } = await c.query<{ score: number }>(`SELECT score FROM daily_report_scale_options WHERE scale_code = 'ANI' AND option_code = '3'`);
        return { f, score: rows[0].score };
      });
      expect(r.f.code).toBe('55000');
      expect(r.score).toBe(3);
    });
    it('UPDATE de option_code de opção referenciada → 55000', async () => {
      const r = await tx(async (c) => {
        await comResposta(c);
        return falha(c, `UPDATE daily_report_scale_options SET option_code = '3x' WHERE scale_code = 'ANI' AND option_code = '3'`);
      });
      expect(r.code).toBe('55000');
    });
    it('opção SEM resposta continua corrigível (nota e texto); opção referenciada aceita correção de texto', async () => {
      await tx(async (c) => {
        await comResposta(c);
        await c.query(`UPDATE daily_report_scale_options SET score = 40 WHERE scale_code = 'ANI' AND option_code = '4'`);
        await c.query(`UPDATE daily_report_scale_options SET meaning_es = 'texto corrigido' WHERE scale_code = 'ANI' AND option_code = '3'`);
        const { rows } = await c.query<{ score: number }>(`SELECT score FROM daily_report_scale_options WHERE scale_code = 'ANI' AND option_code = '4'`);
        expect(rows[0].score).toBe(40);
      });
    });
  });

  describe('privilégios do app', () => {
    it('app_runtime lê as 3 tabelas e não escreve (42501)', async () => {
      await tx(async (c) => {
        await c.query('SET LOCAL ROLE app_runtime');
        for (const t of ['daily_report_scales', 'daily_report_scale_options', 'daily_report_scale_reasons']) {
          const { rows } = await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
          expect(Number(rows[0].n)).toBeGreaterThan(0);
        }
        expect((await falha(c, `UPDATE daily_report_scale_options SET meaning_es = 'x'`)).code).toBe('42501');
        expect((await falha(c, `DELETE FROM daily_report_scale_reasons`)).code).toBe('42501');
        expect((await falha(c, `INSERT INTO daily_report_scales (code, name_es, purpose_es, answered_by, answer_kind) VALUES ('ANI', 'n', 'p', 'AT', 'SINGLE_CHOICE')`)).code).toBe('42501');
      });
    });
  });
});
