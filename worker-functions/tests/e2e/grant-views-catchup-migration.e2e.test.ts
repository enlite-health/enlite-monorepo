import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * Régua da DECISÃO da mig 455 (021-b1, Fase E, isolamento por país): "nenhuma view de
 * `public`/`iam` cujo dono seja o role das migrations fica sem SELECT para `app_runtime`" — o
 * CONSERTO DE CLASSE (laço de catch-up do item b), não a lista nomeada do item (a).
 *
 * ACHADO que este teste fecha: o laço de GRANT da 269 (linhas 44-57) nunca alcançou VIEW nenhuma
 * (`relkind IN ('r','p','S')`) nem o schema `iam` (criado só na 274). A 455 nomeia 11 objetos
 * JÁ CONHECIDOS explicitamente (item a) — mas a régua de VERDADE da classe é o laço (item b): uma
 * view nova, nunca mencionada em migration alguma, tem de nascer legível para
 * `app_runtime`/`app_system` assim que a 455 rodar (idempotente, roda de novo sempre que aplicada).
 *
 * POR QUE AQUI e não em `runtime-role-privilegios.e2e.test.ts`: aquele arquivo mede o ESTADO de
 * privilégio contra a lista fixa de objetos já catalogados (regressão ampla — sabe o nome de cada
 * exceção). Ele NÃO pega a remoção do laço de catch-up: os 9 nomeados no item (a) da 455
 * continuariam concedidos mesmo SEM o laço (grant explícito não depende dele), então o defeito só
 * aparece numa view que ninguém nomeou. Por isso esta régua cria uma view PROBE fora de qualquer
 * lista e RE-EXECUTA o arquivo da migration 455 direto (mesmo padrão de
 * `permission-split-grants-migration.e2e.test.ts`: `readFileSync` + `pool.query(sql)`, não via
 * runner) — só assim o teste exercita o LAÇO, e não a lista nomeada.
 */
describe('migration 455 — laço de catch-up de SELECT em views novas de public/iam (banco real)', () => {
  let pool: Pool;
  const PROBE_VIEW = 'zz_e2e_455_catchup_probe_view';

  function runMigration455SQL(p: Pool): Promise<unknown> {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '455_grant_views_to_app_roles.sql'), 'utf8');
    return p.query(sql);
  }

  async function temSelect(p: Pool, papel: string): Promise<boolean> {
    const { rows } = await p.query<{ tem: boolean }>(
      `SELECT has_table_privilege($1, $2::regclass, 'SELECT') AS tem`,
      [papel, `public.${PROBE_VIEW}`],
    );
    return rows[0].tem;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`DROP VIEW IF EXISTS public.${PROBE_VIEW}`);
    await pool.query(`CREATE VIEW public.${PROBE_VIEW} AS SELECT 1 AS x`);
    // A 269 deixou `ALTER DEFAULT PRIVILEGES ... ON TABLES` ativo para quem a rodou — se este
    // teste rodar com o MESMO role (ex.: `enlite_admin` local), a view nasceria JÁ concedida
    // (o mesmo motivo pelo qual `v_patient_source_inventory`, criada pela 439 depois da 269,
    // aparece com SELECT sem a 455 tocar nela — medido em 20/09/2026). Isso mascararia o teste.
    // O REVOKE abaixo reproduz o estado REAL das 9 views que motivaram a 455: criadas ANTES da
    // 269 existir, sem SELECT nenhum — é essa lacuna que o laço de catch-up (item b) fecha.
    await pool.query(`REVOKE SELECT ON public.${PROBE_VIEW} FROM app_runtime, app_system`);
  });

  afterAll(async () => {
    await pool.query(`DROP VIEW IF EXISTS public.${PROBE_VIEW}`);
    await pool.end();
  });

  it('🔒 controle: a view PROBE nasce SEM select para app_runtime/app_system — prova que ela não está em nenhuma lista nomeada', async () => {
    expect(await temSelect(pool, 'app_runtime')).toBe(false);
    expect(await temSelect(pool, 'app_system')).toBe(false);
  });

  it('re-rodar a 455 fecha a probe — é o laço de catch-up, não a lista nomeada (item a nunca cita esta view)', async () => {
    await runMigration455SQL(pool);
    expect(await temSelect(pool, 'app_runtime')).toBe(true);
    expect(await temSelect(pool, 'app_system')).toBe(true);
  });

  it('idempotência: reaplicar a 455 de novo não erra e mantém a probe concedida', async () => {
    await expect(runMigration455SQL(pool)).resolves.toBeDefined();
    expect(await temSelect(pool, 'app_runtime')).toBe(true);
  });
});
