/**
 * 058a-seed-e-backfill.e2e.test.ts @integration — spec 058 Parte A (T092): seed de células (538), backfill dos donos da cobertura (539) e
 * a fronteira do `enlite_mcp_ro` (534 + create-mcp-ro-role.sql).
 *
 * Postgres REAL, sem mock. As migrations 538/539 são lidas do disco e REEXECUTADAS aqui (idempotentes): é o que faz a sabotagem do arquivo
 * morrer neste teste, e não só na primeira aplicação do banco.
 *   `-t "seed"` (T028) · `-t "backfill literal null"` (T029).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { executarRelatorio } from '../../scripts/relatorio-conflitos-p2a';
import {
  criarContrato, criarPagador, criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, PREFIXO_PACIENTE, vigencia, vincular,
} from './helpers/contrato058aDb';

const MIGRATIONS = path.resolve(__dirname, '../../migrations');
const SQL_538 = path.join(MIGRATIONS, '538_058a_permissoes_seed.sql');
const SQL_539 = path.join(MIGRATIONS, '539_patients_cobertura_dono_backfill.sql');
const SCRIPT_MCP = path.resolve(__dirname, '../../../scripts/create-mcp-ro-role.sql');

const NOVAS: Array<[string, string]> = [
  ['catalog_insurance_providers', 'read'], ['catalog_insurance_providers', 'create'], ['catalog_insurance_providers', 'update'],
  ['insurance_provider_contacts', 'read'], ['insurance_provider_contacts', 'create'], ['insurance_provider_contacts', 'update'],
  ['insurance_contracts', 'read'], ['insurance_contracts', 'create'], ['insurance_contracts', 'update'],
  ['patient_contract_value', 'create'], ['insurance_provider_patients', 'read'],
];
const REFERENCIAS: Array<[string, string]> = [['patient_coverage', 'read'], ['patient_contract_value', 'read'], ['patient_services', 'update']];
const PARES: Array<{ nova: [string, string]; ref: [string, string] }> = [
  { nova: ['insurance_contracts', 'read'], ref: ['patient_services', 'update'] },
  { nova: ['catalog_insurance_providers', 'read'], ref: ['patient_coverage', 'read'] },
  { nova: ['insurance_provider_contacts', 'read'], ref: ['patient_coverage', 'read'] },
  { nova: ['insurance_provider_patients', 'read'], ref: ['patient_coverage', 'read'] },
  { nova: ['patient_contract_value', 'create'], ref: ['patient_contract_value', 'read'] },
];

describe('058a seed de células e backfill da cobertura (538/539) @integration', () => {
  let pool: Pool;

  beforeAll(() => { pool = novoPool(); });
  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${PREFIXO_PACIENTE}%'`);
    await limpar(pool);
    await pool.end();
  });

  const celulas = async (lista: Array<[string, string]>): Promise<number> => {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM iam.permissions p
        WHERE p.deprecated_at IS NULL AND EXISTS (SELECT 1 FROM unnest($1::text[], $2::text[]) AS t(resource, action)
                                                   WHERE t.resource = p.resource AND t.action = p.action)`,
      [lista.map((x) => x[0]), lista.map((x) => x[1])]);
    return r.rows[0].n;
  };

  describe('seed (538)', () => {
    it('seed: as 11 células novas e as 3 referências existem em iam.permissions', async () => {
      expect(await celulas(NOVAS)).toBe(11);
      expect(await celulas(REFERENCIAS)).toBe(3);
    });

    it('seed: reexecutar a 538 num catálogo SEM as 14 células recria as 14 (assert 14) e cada par de grant fala (NOTICE)', async () => {
      const sql = fs.readFileSync(SQL_538, 'utf8');
      const todas = [...NOVAS, ...REFERENCIAS];
      const c = await pool.connect();
      const avisos: string[] = [];
      c.on('notice', (n) => avisos.push(n.message ?? ''));
      try {
        await c.query('BEGIN');
        // tira as 14 do catálogo (e os grants que apontam para elas), só nesta transação
        for (const [resource, action] of todas) {
          await c.query(`DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`, [resource, action]);
          await c.query('DELETE FROM iam.permissions WHERE resource = $1 AND action = $2', [resource, action]);
        }
        const zero = (await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM iam.permissions WHERE (resource, action) IN (${todas.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(',')})`,
          todas.flat())).rows[0].n;
        expect(zero).toBe(0); // a medição enxergaria as 14 se existissem
        await c.query(sql);   // a migration inteira, com o assert de 14 dentro
        const depois = (await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM iam.permissions WHERE (resource, action) IN (${todas.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(',')})`,
          todas.flat())).rows[0].n;
        expect(depois).toBe(14);
        // 5 pares: cada um fala (NOTICE) — com grupos e grants, ou "0 grants"
        for (const { nova, ref } of PARES) {
          expect(avisos.some((m) => m.includes(`${nova[0]}:${nova[1]} <- ${ref[0]}:${ref[1]}`))).toBe(true);
        }
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      expect(await celulas(NOVAS)).toBe(11); // o ROLLBACK devolveu o catálogo
    });

    it('master: o Acesso Master tem as 11 células novas, e reexecutar a 538 sem os grants dele os devolve (prd já enforça admin.patients)', async () => {
      const MASTER = 'a0000000-0000-0000-0000-000000000001';
      const contar = async (q: { query: Pool['query'] }): Promise<number> => (await q.query(
        `SELECT count(*)::int AS n FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
          WHERE gp.group_id = $1 AND (p.resource, p.action) IN (${NOVAS.map((_, i) => `($${2 * i + 2}, $${2 * i + 3})`).join(',')})`,
        [MASTER, ...NOVAS.flat()])).rows[0].n as number;
      expect((await pool.query('SELECT 1 FROM iam.permission_groups WHERE id = $1', [MASTER])).rowCount).toBe(1);
      expect(await contar(pool)).toBe(11);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id IN (SELECT id FROM iam.permissions p
            WHERE (p.resource, p.action) IN (${NOVAS.map((_, i) => `($${2 * i + 2}, $${2 * i + 3})`).join(',')}))`, [MASTER, ...NOVAS.flat()]);
        expect(await contar(c)).toBe(0); // a medição enxergaria os 11 se existissem
        await c.query(fs.readFileSync(SQL_538, 'utf8'));
        expect(await contar(c)).toBe(11);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      expect(await contar(pool)).toBe(11);
    });

    it('pares de grant: todo grupo que tem a referência tem a célula nova (grants ou NOTICE, nunca nem um nem outro)', async () => {
      for (const { nova, ref } of PARES) {
        const r = await pool.query<{ com_ref: number; faltam: number }>(
          `WITH com_ref AS (
             SELECT gp.group_id FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
              WHERE p.resource = $3 AND p.action = $4)
           SELECT (SELECT count(*)::int FROM com_ref) AS com_ref,
                  (SELECT count(*)::int FROM com_ref cr WHERE NOT EXISTS (
                     SELECT 1 FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
                      WHERE gp.group_id = cr.group_id AND p.resource = $1 AND p.action = $2)) AS faltam`,
          [nova[0], nova[1], ref[0], ref[1]]);
        expect(r.rows[0].faltam).toBe(0);
      }
    });
  });

  describe('fronteira do enlite_mcp_ro (534 + create-mcp-ro-role.sql)', () => {
    it('mcp: depois do script oficial, enlite_mcp_ro NÃO lê insurance_provider_contacts (PII cifrada) e LÊ o catálogo (controle positivo)', async () => {
      execFileSync('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-v', 'mcp_ro_password=e2e-local-only', '-1', '-q', '-f', SCRIPT_MCP],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const r = await pool.query<{ contatos: boolean; provedores: boolean }>(
        `SELECT has_table_privilege('enlite_mcp_ro', 'insurance_provider_contacts', 'SELECT') AS contatos,
                has_table_privilege('enlite_mcp_ro', 'insurance_providers', 'SELECT') AS provedores`);
      expect(r.rows[0]).toEqual({ contatos: false, provedores: true });
    });
  });

  describe('backfill dos donos da cobertura (539)', () => {
    const paciente = async (nome: string | null, afiliado: string | null, donoNome: string | null = null, donoAfiliado: string | null = null) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, health_insurance_name, health_insurance_member_id, insurance_informed, affiliate_id)
         VALUES ($1, 'QA058', 'Backfill QA', 'AR', 'ACTIVE', $2, $3, $4, $5) RETURNING id`,
        [`${PREFIXO_PACIENTE}BF-${Math.random().toString(36).slice(2, 10)}`, nome, afiliado, donoNome, donoAfiliado])).rows[0].id;
    const dono = async (id: string) =>
      (await pool.query<{ insurance_informed: string | null; affiliate_id: string | null }>(
        'SELECT insurance_informed, affiliate_id FROM patients WHERE id = $1', [id])).rows[0];
    const rodar539 = (): Promise<unknown> => pool.query(fs.readFileSync(SQL_539, 'utf8'));

    it('backfill literal null: "null", vazio e só-espaço NÃO copiam; o dono fica NULL', async () => {
      const lit = await paciente('null', 'NULL');
      const vazio = await paciente('', '   ');
      const espaco = await paciente('  Null  ', ' null ');
      await rodar539();
      expect(await dono(lit)).toEqual({ insurance_informed: null, affiliate_id: null });
      expect(await dono(vazio)).toEqual({ insurance_informed: null, affiliate_id: null });
      expect(await dono(espaco)).toEqual({ insurance_informed: null, affiliate_id: null });
    });

    it('backfill: valores reais são copiados com btrim do texto ORIGINAL (não o minúsculo)', async () => {
      const id = await paciente('  Swiss Medical ', ' 12345/6 ');
      await rodar539();
      expect(await dono(id)).toEqual({ insurance_informed: 'Swiss Medical', affiliate_id: '12345/6' });
    });

    it('backfill: dono já preenchido nunca é sobrescrito, e rodar 2× não muda nada (idempotente)', async () => {
      const id = await paciente('OSDE', 'AAA', 'galeno', 'ZZZ');
      await rodar539();
      await rodar539();
      expect(await dono(id)).toEqual({ insurance_informed: 'galeno', affiliate_id: 'ZZZ' });
    });

    it('backfill: não toca updated_at (não acorda leitor de "paciente mudou")', async () => {
      const id = await paciente('Omint', 'B1');
      const antes = (await pool.query('SELECT updated_at FROM patients WHERE id = $1', [id])).rows[0].updated_at;
      await rodar539();
      const depois = (await pool.query('SELECT updated_at FROM patients WHERE id = $1', [id])).rows[0].updated_at;
      expect((await dono(id)).insurance_informed).toBe('Omint');
      expect(depois).toEqual(antes);
    });
  });
  describe('relatório Q1–Q6 contra Postgres (T031) — delta sobre o que já existe no banco', () => {
    const ASOF = { ar: '2026-10-19', br: '2026-10-19' };
    const contagens = async (): Promise<Record<string, number>> =>
      Object.fromEntries((await executarRelatorio(pool, ASOF)).map((l) => [l.id, l.conflitos]));
    const pac = async (c: Record<string, string | null>): Promise<string> =>
      (await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, health_insurance_name, insurance_informed,
                               health_insurance_member_id, affiliate_id, insurance_verified)
         VALUES ($1, 'QA058', 'Relatorio QA', 'AR', 'ACTIVE', $2, $3, $4, $5, $6) RETURNING id`,
        [`${PREFIXO_PACIENTE}RQ-${Math.random().toString(36).slice(2, 10)}`, c.nome ?? null, c.dono ?? null, c.membro ?? null, c.afiliado ?? null, c.verificado ?? null])).rows[0].id;

    afterEach(async () => { await limpar(pool); });

    it('relatório Q5/Q6: "null" no legado com dono NULL e "Swiss" × "swiss" NÃO são conflito; "OSDE" com dono NULL é (N nos dois lados)', async () => {
      const antes = await contagens();
      await pac({ nome: 'null', dono: null, membro: 'NULL', afiliado: null });        // legado "ausente": 0
      await pac({ nome: 'Swiss', dono: 'swiss', membro: ' AB-1 ', afiliado: 'ab-1' }); // só caixa/espaço: 0
      await pac({ nome: '   ', dono: 'x', membro: '', afiliado: 'y' });                 // legado só-espaço/vazio: 0
      await pac({ nome: 'OSDE', dono: null, membro: '777', afiliado: null });           // divergência real: +1 em cada
      const depois = await contagens();
      expect([depois.Q5 - antes.Q5, depois.Q6 - antes.Q6]).toEqual([1, 1]);
    });

    it('relatório Q4: só o ordinal 1 com source clickup vale; admin_manual e ausência de linha divergem', async () => {
      const antes = await contagens();
      const igual = await pac({ verificado: 'Swiss Medical' });
      const manual = await pac({ verificado: 'Swiss Medical' });
      const sem = await pac({ verificado: 'Swiss Medical' });
      await pool.query(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source) VALUES ($1, 1, ' swiss medical ', 'clickup')`, [igual]);
      await pool.query(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source) VALUES ($1, 1, 'Swiss Medical', 'admin_manual')`, [manual]);
      expect(sem).toBeTruthy();
      const depois = await contagens();
      expect(depois.Q4 - antes.Q4).toBe(2); // `manual` e `sem`; `igual` bate depois do N()
    });

    it('relatório Q1–Q3: serviço sem vínculo diverge; com vínculo e termo que batem (valor, imposto IVA→%, payer_kind) não diverge; com termo diferente diverge', async () => {
      const prov = await criarPagador(pool, 'OBRA_SOCIAL');
      const contrato = await criarContrato(pool, prov);
      await pool.query(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, 1500, 21, '[2026-01-01,)', 'qa058a')`, [contrato]);
      const paciente = await criarPaciente(pool);
      const servico = async (valor: number, iva: string, tipo: string): Promise<string> => {
        const id = await criarServico(pool, paciente);
        await pool.query('UPDATE patient_contracted_services SET hourly_value = $2, tax_condition = $3, contract_type = $4 WHERE id = $1', [id, valor, iva, tipo]);
        return id;
      };
      const antes = await contagens();
      const bate = await servico(1500, 'IVA_21', 'OBRA_SOCIAL');
      const difere = await servico(1400, 'IVA_10_5', 'PREPAGA');
      await servico(1500, 'IVA_21', 'OBRA_SOCIAL'); // sem vínculo: diverge nas três
      await vincular(pool, bate, contrato, vigencia('2026-01-01'));
      // `difere` ficaria com 2 vivas no mesmo paciente se vinculado ao mesmo pagador de outro serviço; vincula-se o mesmo contrato (mesmo pagador)
      await vincular(pool, difere, contrato, vigencia('2026-01-01'));
      const depois = await contagens();
      expect([depois.Q1 - antes.Q1, depois.Q2 - antes.Q2, depois.Q3 - antes.Q3]).toEqual([2, 2, 2]); // `difere` + o sem vínculo
    });
  });
});
