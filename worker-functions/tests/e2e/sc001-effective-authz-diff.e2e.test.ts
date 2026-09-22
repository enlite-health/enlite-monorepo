import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MIGRATION_276_PATH = path.join(__dirname, '..', '..', 'migrations', '276_effective_authz_functions.sql');
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'sc001-effective-authz-diff.sql');

const GERADO_START = '-- ===== GERADO (início) =====';
const GERADO_END = '-- ===== GERADO (fim) =====';

/**
 * Spec 026 — SC-001 (T1.4, BLOQUEANTE da F1): a `iam.effective_permissions`/`effective_countries`
 * da migration 458 (fonte trocada de `iam.user_groups` para `iam.acting_groups`) continuam
 * idênticas às da 276 (pré-458) para TODO usuário × tenant QUANDO NÃO HÁ SIMULAÇÃO ABERTA.
 * `iam.effective_permissions` está no caminho quente do engine LIGADO em prd (D406) — um diff ≠ 0
 * aqui é lockout/vazamento em potencial (regra de continuidade da spec: PARA, não "ajusta o teste").
 *
 * (1) prova que `scripts/sc001-effective-authz-diff.sql` não envelheceu (o bloco GERADO bate com o
 *     que se extrai/substitui HOJE de `migrations/276_effective_authz_functions.sql`) e roda o
 *     diff — plantando fixtures dentro da MESMA transação (ROLLBACK no fim) para provar `N > 0`
 *     sem depender do banco já ter usuários reais.
 * (2) prova positiva: sob simulação de um grupo sem célula, o mesmo instrumento acusa diferença
 *     (`diff_permissions >= 1`) — sem isso, um diff sempre 0 poderia ser o instrumento cego, não
 *     ausência real de divergência (CLAUDE.md: contagem zero é falha até prova positiva).
 */
describe('spec 026 — SC-001: diff efetivo antes/depois da 458 (T1.4)', () => {
  let pool: Pool;
  let migration276Text: string;
  let scriptText: string;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const MASTER_GROUP_ID = 'a0000000-0000-0000-0000-000000000001';

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    migration276Text = fs.readFileSync(MIGRATION_276_PATH, 'utf8');
    scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Extrai `CREATE OR REPLACE FUNCTION <fnName> ... $$;` (a função inteira, sem COMMENT ON). */
  function extractFunctionBlock(text: string, fnName: string): string {
    const lines = text.split('\n');
    const startRe = new RegExp(`^CREATE OR REPLACE FUNCTION ${fnName.replace(/\./g, '\\.')}`);
    const startIdx = lines.findIndex((l) => startRe.test(l));
    if (startIdx === -1) throw new Error(`bloco de ${fnName} não encontrado em ${MIGRATION_276_PATH}`);
    let endIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
      if (lines[i].trim() === '$$;') {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) throw new Error(`fechamento "$$;" de ${fnName} não encontrado após a linha ${startIdx}`);
    return lines.slice(startIdx, endIdx + 1).join('\n');
  }

  /** Replica EXATAMENTE o comando awk/sed do cabeçalho de sc001-effective-authz-diff.sql. */
  function generateSc001Block(migration276: string): string {
    const perm = extractFunctionBlock(migration276, 'iam.effective_permissions').replace(
      /iam\.effective_permissions/g,
      'sc001.effective_permissions',
    );
    const countries = extractFunctionBlock(migration276, 'iam.effective_countries').replace(
      /iam\.effective_countries/g,
      'sc001.effective_countries',
    );
    return `${perm}\n\n${countries}`;
  }

  function extractMarkedBlock(script: string): string {
    const start = script.indexOf(GERADO_START);
    const end = script.indexOf(GERADO_END);
    if (start === -1 || end === -1) throw new Error(`marcadores GERADO não encontrados em ${SCRIPT_PATH}`);
    return script.slice(start + GERADO_START.length, end).trim();
  }

  /** Corpo do script sem o `BEGIN;`/`ROLLBACK;` próprios — para rodar dentro de uma transação já aberta pelo teste. */
  function scriptBody(script: string): string {
    const withoutBegin = script.replace('BEGIN;', '');
    const lastRollback = withoutBegin.lastIndexOf('ROLLBACK;');
    if (lastRollback === -1) throw new Error('ROLLBACK; final não encontrado em sc001-effective-authz-diff.sql');
    return withoutBegin.slice(0, lastRollback);
  }

  function parseLinha(linha: string): { usuarios: number; tenants: number; pares: number; diffPerm: number; diffCountry: number } {
    const m = linha.match(/usuarios=(\d+) tenants=(\d+) pares=(\d+) diff_permissions=(\d+) diff_countries=(\d+)/);
    if (!m) throw new Error(`linha fora do formato esperado: "${linha}"`);
    return { usuarios: Number(m[1]), tenants: Number(m[2]), pares: Number(m[3]), diffPerm: Number(m[4]), diffCountry: Number(m[5]) };
  }

  it('script standalone == gerado da 276 agora (sem drift); sem simulação, diff = 0 para todos (N > 0 plantado)', async () => {
    // (i) o bloco GERADO do .sql do repo não envelheceu.
    const generated = generateSc001Block(migration276Text);
    const embedded = extractMarkedBlock(scriptText);
    expect(embedded).toBe(generated);

    // (ii) premissa do diff = 0: nenhuma simulação residual de execução anterior.
    const openGlobal = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM iam.group_simulations WHERE ended_at IS NULL`);
    expect(Number(openGlobal.rows[0].n)).toBe(0);

    // (iii) planta N > 0 usuários reais DENTRO da transação do próprio diff (ROLLBACK desfaz tudo:
    // nem os usuários nem o schema sc001 sobrevivem) — prova N > 0 sem depender de dado do banco.
    const client: PoolClient = await pool.connect();
    let linha = '';
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
           ($1, 'qa.sc001.fx1@enlite.test', 'admin',     'ACTIVE', true, $4),
           ($2, 'qa.sc001.fx2@enlite.test', 'recruiter', 'ACTIVE', true, $4),
           ($3, 'qa.sc001.fx3@enlite.test', 'recruiter', 'ACTIVE', true, $4)`,
        ['sc001-fx-1', 'sc001-fx-2', 'sc001-fx-3', TENANT],
      );
      // fx1: membro vivo do Acesso Master real (mesma fonte antes/depois sem simulação — iguais).
      await client.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
        'sc001-fx-1',
        MASTER_GROUP_ID,
        TENANT,
      ]);
      // fx2/fx3: sem grupo nenhum — [] dos dois lados.

      const results = (await client.query(scriptBody(scriptText))) as unknown as Array<{ rows: Array<{ linha: string }> }>;
      linha = results[results.length - 1].rows[0].linha;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    // eslint-disable-next-line no-console
    console.log(`[SC-001][sem simulação] ${linha}`);
    const { usuarios, diffPerm, diffCountry } = parseLinha(linha);
    expect(usuarios).toBeGreaterThan(0);
    expect(diffPerm).toBe(0);
    expect(diffCountry).toBe(0);
  });

  it('prova positiva: sob simulação de grupo sem célula, o instrumento vê a diferença (diff_permissions >= 1)', async () => {
    const MASTER_UID = 'sc001-master-1';
    const GROUP_NAME = 'E2E SC001 grupo sem célula (prova positiva)';

    const client: PoolClient = await pool.connect();
    let linha = '';
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
         VALUES ($1, 'qa.sc001.master1@enlite.test', 'admin', 'ACTIVE', true, $2)`,
        [MASTER_UID, TENANT],
      );
      await client.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
        MASTER_UID,
        MASTER_GROUP_ID,
        TENANT,
      ]);
      const g = await client.query<{ id: string }>(
        `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system)
         VALUES ($1, $2, 'e2e SC001 — grupo vivo sem célula (prova positiva do diff)', false) RETURNING id`,
        [TENANT, GROUP_NAME],
      );
      const groupId = g.rows[0].id;

      // Ator = MASTER_UID via GUC (iam._actor()); a conexão já é `enlite_admin`, dona das writer
      // functions SECURITY DEFINER — não precisa de SET LOCAL ROLE (confirmado: has_function_privilege
      // por ownership). Simulação e diff rodam na MESMA transação; ROLLBACK no fim não deixa nada.
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [MASTER_UID]);
      await client.query(`SELECT (iam.start_group_simulation($1, $2::interval)).id AS id`, [groupId, '1 hour']);

      const results = (await client.query(scriptBody(scriptText))) as unknown as Array<{ rows: Array<{ linha: string }> }>;
      linha = results[results.length - 1].rows[0].linha;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    // eslint-disable-next-line no-console
    console.log(`[SC-001][prova positiva] ${linha} | método: dentro da transação`);
    const { diffPerm } = parseLinha(linha);
    expect(diffPerm).toBeGreaterThanOrEqual(1);
  });
});
