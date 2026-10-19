/**
 * 058a-payer-kind.e2e.test.ts @integration — spec 058 Parte A (T090): travas de BANCO do `payer_kind` (migrations 532, 533, 535).
 *
 * Postgres REAL, sem mock. Prova: CHECKs `PRIVATE`/`OTHER`, T6′ (classificado não volta a NULL — PATCH, ON CONFLICT e lote), T5 (contrato só
 * sob pagador classificado), o assert de nomes da 532 sobre a TABELA INTEIRA (R1), o rastro da (re)classificação (533) e T5 × T6′ com 2 conexões.
 *
 * Nomes dos testes casam com as linhas SABOTAGEM de tasks.md T021/T022/T024/T090:
 *   `-t "T6′ recusa"` · `-t "CHECK PRIVATE"` · `-t "CHECK OTHER"` · `-t "assert de nomes"` · `-t "rastro"` · `-t "T5 recusa"` · `-t "T5 × T6′"`.
 * (Os testes de T5 e de concorrência não levam "T5" no mesmo prefixo, para o `-t` de um não pegar o outro.)
 *
 * Parte API/HTTP (A1.4, rotas reais): PATCH `payerKind` em `withActorContext` (rastro com o uid do ator), 422 `PAYER_KIND_CANNOT_UNSET`
 * e `PAYER_KIND_REQUIRED` na criação de contrato — bloco `API/HTTP` no fim.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import {
  criarContrato, criarPagador, emTransacaoRevertida, erroDe, limpar, novoPool, PREFIXO_PAGADOR,
} from './helpers/contrato058aDb';
import { api, atores, BASE } from './helpers/contrato058aApi';
import type { StaffAuth } from './helpers/staffAuth';

const MIGRATION_532 = path.resolve(__dirname, '../../migrations/532_insurance_providers_cadastro.sql');

describe('058a payer_kind — travas de banco (532/533/535) @integration', () => {
  let pool: Pool;

  beforeAll(async () => { pool = novoPool(); await limpar(pool); });
  beforeEach(async () => { await limpar(pool); });
  afterAll(async () => { await limpar(pool); await pool.end(); });

  const kindDe = async (code: string): Promise<string | null> =>
    (await pool.query<{ payer_kind: string | null }>('SELECT payer_kind FROM insurance_providers WHERE code = $1', [code])).rows[0].payer_kind;

  describe('CHECKs de PRIVATE e OTHER (532)', () => {
    it('CHECK PRIVATE: o código PRIVATE não vira OBRA_SOCIAL (23514, insurance_providers_private_kind_chk)', async () => {
      const e = await emTransacaoRevertida(pool, (c) => erroDe(() => c.query(`UPDATE insurance_providers SET payer_kind = 'OBRA_SOCIAL' WHERE code = 'PRIVATE'`)));
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_providers_private_kind_chk');
    });

    it('CHECK PRIVATE (controle positivo): PRIVATE como PRIVATE passa e é o que a 532 gravou', async () => {
      expect((await pool.query(`SELECT payer_kind FROM insurance_providers WHERE code = 'PRIVATE'`)).rows[0].payer_kind).toBe('PRIVATE');
      const e = await emTransacaoRevertida(pool, (c) => erroDe(() => c.query(`UPDATE insurance_providers SET payer_kind = 'PRIVATE' WHERE code = 'PRIVATE'`)));
      expect(e).toBeNull();
    });

    it('CHECK OTHER: o código OTHER não é classificado (23514, insurance_providers_other_unclassified_chk)', async () => {
      const e = await emTransacaoRevertida(pool, (c) => erroDe(() => c.query(`UPDATE insurance_providers SET payer_kind = 'PREPAGA' WHERE code = 'OTHER'`)));
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_providers_other_unclassified_chk');
    });

    it('enum do payer_kind: valor fora de OBRA_SOCIAL|PREPAGA|PRIVATE é recusado (23514)', async () => {
      const code = await criarPagador(pool, null);
      const e = await erroDe(() => pool.query(`UPDATE insurance_providers SET payer_kind = 'COOPERATIVA' WHERE code = $1`, [code]));
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_providers_payer_kind_check');
    });
  });

  describe('T6′ — classificado não volta a NULL (532)', () => {
    it('T6′ recusa: PATCH payer_kind = NULL num classificado (PAYER_KIND_CANNOT_UNSET)', async () => {
      const code = await criarPagador(pool, 'OBRA_SOCIAL');
      const e = await erroDe(() => pool.query('UPDATE insurance_providers SET payer_kind = NULL WHERE code = $1', [code]));
      expect(e?.message).toContain('PAYER_KIND_CANNOT_UNSET');
      expect(await kindDe(code)).toBe('OBRA_SOCIAL');
    });

    it('T6′ recusa: INSERT … ON CONFLICT DO UPDATE SET payer_kind = NULL (upsert)', async () => {
      const code = await criarPagador(pool, 'PREPAGA');
      const e = await erroDe(() => pool.query(
        `INSERT INTO insurance_providers (code, name, sort_order, payer_kind) VALUES ($1, 'x', 32000, NULL)
         ON CONFLICT (code) DO UPDATE SET payer_kind = EXCLUDED.payer_kind`, [code]));
      expect(e?.message).toContain('PAYER_KIND_CANNOT_UNSET');
      expect(await kindDe(code)).toBe('PREPAGA');
    });

    it('T6′ recusa: UPDATE em lote derruba o lote inteiro (nenhuma linha fica NULL)', async () => {
      const a = await criarPagador(pool, 'OBRA_SOCIAL');
      const b = await criarPagador(pool, 'PREPAGA');
      const e = await erroDe(() => pool.query(`UPDATE insurance_providers SET payer_kind = NULL WHERE code LIKE '${PREFIXO_PAGADOR}%'`));
      expect(e?.message).toContain('PAYER_KIND_CANNOT_UNSET');
      expect([await kindDe(a), await kindDe(b)]).toEqual(['OBRA_SOCIAL', 'PREPAGA']);
    });

    it('T6′ permite: reclassificar OBRA_SOCIAL → PREPAGA e classificar um NULL (controles positivos)', async () => {
      const a = await criarPagador(pool, 'OBRA_SOCIAL');
      const b = await criarPagador(pool, null);
      await pool.query(`UPDATE insurance_providers SET payer_kind = 'PREPAGA' WHERE code = $1`, [a]);
      await pool.query(`UPDATE insurance_providers SET payer_kind = 'OBRA_SOCIAL' WHERE code = $1`, [b]);
      expect([await kindDe(a), await kindDe(b)]).toEqual(['PREPAGA', 'OBRA_SOCIAL']);
    });
  });

  describe('T5 — contrato só sob pagador classificado (535)', () => {
    it('T5 recusa: contrato para pagador NULL → PAYER_KIND_REQUIRED, nada gravado', async () => {
      const code = await criarPagador(pool, null);
      const e = await erroDe(() => criarContrato(pool, code));
      expect(e?.message).toContain('PAYER_KIND_REQUIRED');
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contracts WHERE provider_code = $1', [code])).rows[0].n).toBe(0);
    });

    it('T5 permite: contrato para pagador classificado nasce (controle positivo)', async () => {
      const code = await criarPagador(pool, 'PREPAGA');
      const id = await criarContrato(pool, code);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('assert de nomes da 532 (R1) — sobre a TABELA INTEIRA, não o literal 33', () => {
    it('assert de nomes: um 34º código sem alias e fora da lista ganha initcap(code) e a migration passa', async () => {
      const sql = fs.readFileSync(MIGRATION_532, 'utf8');
      const code = `${PREFIXO_PAGADOR}EXTRA_SEM_ALIAS`;
      const antes = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM insurance_providers')).rows[0].n;
      const depois = await emTransacaoRevertida(pool, async (c) => {
        // simula o prd "34º código criado depois da 311": a coluna ainda não tem nome
        await c.query('ALTER TABLE insurance_providers ALTER COLUMN name DROP NOT NULL');
        await c.query(
          `INSERT INTO insurance_providers (code, sort_order, name) VALUES ($1, (SELECT MAX(sort_order) + 1 FROM insurance_providers), NULL)`, [code]);
        await c.query(sql); // a migration inteira, de novo, idempotente: backfill + SET NOT NULL + assert
        return (await c.query<{ name: string; total: number }>(
          'SELECT name, (SELECT count(*)::int FROM insurance_providers) AS total FROM insurance_providers WHERE code = $1', [code])).rows[0];
      });
      expect(antes).toBeGreaterThanOrEqual(33);
      expect(depois.total).toBe(antes + 1);
      expect(depois.name).toBe('Qa058_Extra_Sem_Alias'); // initcap(code)
    });

    it('assert de nomes (controle): a lista literal deu nome aos 33 originais, distintos entre si', async () => {
      const r = await pool.query<{ total: number; com_nome: number; distintos: number }>(
        `SELECT count(*)::int AS total, count(name)::int AS com_nome, count(DISTINCT lower(btrim(name)))::int AS distintos FROM insurance_providers`);
      expect(r.rows[0].total).toBe(r.rows[0].com_nome);
      expect(r.rows[0].total).toBe(r.rows[0].distintos);
      expect((await pool.query(`SELECT name FROM insurance_providers WHERE code = 'OGORMAN'`)).rows[0].name).toBe("O'Gorman");
    });

    it('nomes: dois pagadores com o mesmo nome (caixa/espaço) são recusados (índice único insurance_providers_name_uq, 23505)', async () => {
      const a = await criarPagador(pool, null);
      const e = await erroDe(() => pool.query(
        `INSERT INTO insurance_providers (code, name, sort_order) VALUES ($1, '  ' || upper($2) || ' ', 32001)`, [`${PREFIXO_PAGADOR}DUP`, `QA058 ${a}`]));
      expect(e?.code).toBe('23505');
      expect(e?.constraint).toBe('insurance_providers_name_uq');
    });
  });

  describe('trilha da classificação do pagador (533)', () => {
    it('rastro: reclassificar grava uma linha com changed_by = app.current_uid', async () => {
      const code = await criarPagador(pool, null);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.current_uid', 'staff:qa-058a', true)`);
        await c.query(`UPDATE insurance_providers SET payer_kind = 'OBRA_SOCIAL' WHERE code = $1`, [code]);
        await c.query('COMMIT');
      } finally { c.release(); }
      const h = (await pool.query(`SELECT old_kind, new_kind, changed_by FROM insurance_provider_payer_kind_history WHERE provider_code = $1`, [code])).rows;
      expect(h).toEqual([{ old_kind: null, new_kind: 'OBRA_SOCIAL', changed_by: 'staff:qa-058a' }]);
    });

    it('rastro: OBRA_SOCIAL → PREPAGA grava old/new na ordem certa', async () => {
      const code = await criarPagador(pool, 'OBRA_SOCIAL'); // o INSERT já classificado também deixa linha
      await pool.query(`UPDATE insurance_providers SET payer_kind = 'PREPAGA' WHERE code = $1`, [code]);
      const h = (await pool.query(
        `SELECT old_kind, new_kind FROM insurance_provider_payer_kind_history WHERE provider_code = $1 ORDER BY id`, [code])).rows;
      expect(h).toEqual([{ old_kind: null, new_kind: 'OBRA_SOCIAL' }, { old_kind: 'OBRA_SOCIAL', new_kind: 'PREPAGA' }]);
    });

    it('histórico sem ator: UPDATE à mão, sem app.current_uid, grava changed_by NULL (nunca inferir)', async () => {
      const code = await criarPagador(pool, null);
      await pool.query(`UPDATE insurance_providers SET payer_kind = 'PREPAGA' WHERE code = $1`, [code]);
      const h = (await pool.query(`SELECT changed_by FROM insurance_provider_payer_kind_history WHERE provider_code = $1`, [code])).rows;
      expect(h).toEqual([{ changed_by: null }]);
    });

    it('histórico imutável: UPDATE e DELETE na trilha são recusados (55000)', async () => {
      const code = await criarPagador(pool, 'OBRA_SOCIAL');
      const up = await erroDe(() => pool.query(`UPDATE insurance_provider_payer_kind_history SET new_kind = 'PREPAGA' WHERE provider_code = $1`, [code]));
      const del = await erroDe(() => pool.query('DELETE FROM insurance_provider_payer_kind_history WHERE provider_code = $1', [code]));
      expect([up?.code, del?.code]).toEqual(['55000', '55000']);
    });

    it('histórico semeado: o PRIVATE da 532 está na trilha como system:migration-532', async () => {
      const h = (await pool.query(`SELECT new_kind, changed_by FROM insurance_provider_payer_kind_history WHERE provider_code = 'PRIVATE'`)).rows;
      expect(h).toContainEqual({ new_kind: 'PRIVATE', changed_by: 'system:migration-532' });
    });
  });

  describe('T5 × T6′ concorrentes — 2 conexões reais', () => {
    it('T5 × T6′ (1): OBRA_SOCIAL → PREPAGA × POST de contrato — ambas commitam, contrato sob PREPAGA', async () => {
      const code = await criarPagador(pool, 'OBRA_SOCIAL');
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query(`UPDATE insurance_providers SET payer_kind = 'PREPAGA' WHERE code = $1`, [code]); // ainda não commitado
        await b.query('BEGIN');
        await criarContrato(b, code);                                                                   // não bloqueia: FK pega KEY SHARE, o UPDATE é NO KEY
        await b.query('COMMIT');
        await a.query('COMMIT');
      } finally { a.release(); b.release(); }
      expect(await kindDe(code)).toBe('PREPAGA');
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contracts WHERE provider_code = $1', [code])).rows[0].n).toBe(1);
    });

    it('T5 × T6′ (2): PATCH NULL × POST com pagador classificado — o PATCH é recusado, o POST passa', async () => {
      const code = await criarPagador(pool, 'OBRA_SOCIAL');
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        const eA = await erroDe(() => a.query('UPDATE insurance_providers SET payer_kind = NULL WHERE code = $1', [code]));
        await a.query('ROLLBACK');
        await b.query('BEGIN');
        await criarContrato(b, code);
        await b.query('COMMIT');
        expect(eA?.message).toContain('PAYER_KIND_CANNOT_UNSET');
      } finally { a.release(); b.release(); }
      expect(await kindDe(code)).toBe('OBRA_SOCIAL');
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contracts WHERE provider_code = $1', [code])).rows[0].n).toBe(1);
    });

    it('T5 × T6′ (3): NULL × classificação concorrente — o POST antes do commit é recusado; contrato nunca nasce sob NULL', async () => {
      const code = await criarPagador(pool, null);
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query(`UPDATE insurance_providers SET payer_kind = 'OBRA_SOCIAL' WHERE code = $1`, [code]); // ainda não commitado
        const eB = await erroDe(() => criarContrato(b, code));                                              // B lê NULL → recusa (lado seguro)
        expect(eB?.message).toContain('PAYER_KIND_REQUIRED');
        expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contracts WHERE provider_code = $1', [code])).rows[0].n).toBe(0);
        await a.query('COMMIT');
        await criarContrato(b, code);                                                                       // depois do commit o operador repete e passa
      } finally { a.release(); b.release(); }
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contracts WHERE provider_code = $1', [code])).rows[0].n).toBe(1);
    });
  });

  describe('API/HTTP — rotas reais (A1.4)', () => {
    let admin: StaffAuth;
    let recrutadora: StaffAuth;
    beforeAll(async () => { ({ admin, recrutadora } = await atores()); });

    it('PATCH /insurance-providers/:code { payerKind: null } num classificado → 422 PAYER_KIND_CANNOT_UNSET e o tipo não muda', async () => {
      const code = await criarPagador(pool, 'PREPAGA');
      const r = await api.patch(`${BASE}/insurance-providers/${code}`, { payerKind: null }, admin);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('PAYER_KIND_CANNOT_UNSET');
      expect(await kindDe(code)).toBe('PREPAGA');
      // controle: ausente não toca, e a recrutadora (sem a célula; engine desligado => só admin) leva 403
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { address: 'Av. Siempre Viva 742' }, admin)).status).toBe(200);
      expect(await kindDe(code)).toBe('PREPAGA');
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { payerKind: 'OBRA_SOCIAL' }, recrutadora)).status).toBe(403);
    });

    it('PATCH de payerKind roda em withActorContext: o rastro sai com changed_by = staff:<uid do admin> (e a 1ª classificação também)', async () => {
      const code = await criarPagador(pool, null);
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { payerKind: 'OBRA_SOCIAL' }, admin)).status).toBe(200);
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { payerKind: 'PREPAGA' }, admin)).status).toBe(200);
      const { rows } = await pool.query<{ old_kind: string | null; new_kind: string; changed_by: string }>(
        `SELECT old_kind, new_kind, changed_by FROM insurance_provider_payer_kind_history WHERE provider_code = $1 ORDER BY changed_at, id`, [code]);
      expect(rows).toEqual([
        { old_kind: null, new_kind: 'OBRA_SOCIAL', changed_by: `staff:${admin.uid}` }, // convenção do app.current_uid (resolveActor)
        { old_kind: 'OBRA_SOCIAL', new_kind: 'PREPAGA', changed_by: `staff:${admin.uid}` },
      ]);
    });

    it('PATCH: o CHECK de PRIVATE chega como 422 INVALID_<constraint>; código inexistente é 404; `code` no corpo é 422', async () => {
      const r = await api.patch(`${BASE}/insurance-providers/PRIVATE`, { payerKind: 'PREPAGA' }, admin);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('INVALID_insurance_providers_private_kind_chk');
      expect((await api.patch(`${BASE}/insurance-providers/NAO_EXISTE_058`, { active: false }, admin)).status).toBe(404);
      const code = await criarPagador(pool, 'OBRA_SOCIAL');
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { code: 'OUTRO' }, admin)).data.code).toBe('CODE_IMMUTABLE');
    });

    it('POST de contrato para pagador sem tipo → 422 PAYER_KIND_REQUIRED, e nenhum contrato nasce (nem o termo)', async () => {
      const code = await criarPagador(pool, null);
      const body = { name: 'Plan sin tipo', country: 'AR', firstTerm: { hourlyRate: 1500, taxRatePercent: 0, validFrom: '2026-01-01' } };
      const r = await api.post(`${BASE}/insurance-providers/${code}/contracts`, body, admin);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('PAYER_KIND_REQUIRED');
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contracts WHERE provider_code = $1', [code])).rows[0].n).toBe(0);
      // classificado: o mesmo corpo passa (controle positivo) e o 1º termo nasce na MESMA transação
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { payerKind: 'OBRA_SOCIAL' }, admin)).status).toBe(200);
      const ok = await api.post(`${BASE}/insurance-providers/${code}/contracts`, body, admin);
      expect(ok.status).toBe(201);
      expect(ok.data.data.currentTerm).toMatchObject({ state: 'OK', taxRatePercent: 0, price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' } });
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_contract_terms WHERE contract_id = $1', [ok.data.data.id])).rows[0].n).toBe(1);
    });
  });
});
