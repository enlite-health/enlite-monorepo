/**
 * O papel de RUNTIME enxerga o que a API precisa? (banco real — LISTA da 419, 09/09/2026)
 *
 * A classe de defeito: **o CI roda a API como DONA do banco (`enlite_admin`), a stage roda como
 * `enlite_runtime` (membro de `app_runtime`, RLS ligado)**. Schema/tabela novo sem `GRANT` passa verde
 * na suíte inteira e só aparece na stage — foi o schema `terminology` (a 323 concedeu só à dona):
 * `/api/admin/terminology/search` dava 503 com o catálogo carregado, e a 419 nasceu disso.
 *
 * ⚠️ Régua de catálogo NÃO basta, e isto foi medido (gate de 09/09): com `REVOKE USAGE ON SCHEMA`,
 * `has_schema_privilege` = **false** e `has_table_privilege` = **true** — a ACL da tabela não sabe
 * do schema. Um teste que só olhasse `has_table_privilege` ficaria VERDE com o defeito da D303 no
 * lugar. Por isso aqui há três camadas:
 *   1. LEITURA REAL como login membro do grupo (pega USAGE e SELECT juntos, é a prova que vale);
 *   2. `has_schema_privilege` por papel × schema;
 *   3. varredura de catálogo por relação — a única que cobre as ~230 tabelas uma a uma.
 */
import { Pool } from 'pg';
import { urlFor, ensureLoginRole, dropLoginRoles } from './helpers/loginRoles';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** Schemas que a aplicação lê em runtime (`grep 'FROM <schema>.' src/` + `CREATE SCHEMA` nas migrations). */
const SCHEMAS = ['public', 'iam', 'terminology'] as const;
/** Piso por schema: "a query voltou vazia" não pode passar por sucesso, e um schema inteiro fora da régua também não. */
const PISO_POR_SCHEMA: Record<string, number> = { public: 120, iam: 95, terminology: 3 };
const PAPEIS = ['app_runtime', 'app_system'] as const;

/** Trilhas append-only: o runtime ESCREVE e não LÊ. As partições saem de `pg_inherits`, não de substring. */
const TRILHAS = ['iam.permission_audit_log', 'public.resource_access_log'] as const;

/**
 * Dívida MEDIDA em 09/09/2026, não exceção: 8 views sem `SELECT` para os papéis de runtime. Três
 * delas são lidas por código de produção (`AnalyticsRepository`, `AuditRepositories`) — mesma classe
 * do 503 da stage, esperando a virada do RLS. A lista é FECHADA de propósito: view nova sem grant
 * reprova aqui, e consertar os grants também reprova (obriga a atualizar a lista no mesmo PR).
 * ⚖️ A migration que concede está na fila do Gabriel; este teste só impede que a dívida CRESÇA.
 */
const DIVIDA_VIEWS_SEM_GRANT = [
  'public.permission_audit_log', // view de compat da trilha — negada de propósito (iam-permissions-foundation)
  'public.users_active',
  'public.v_potential_duplicate_workers', // 🔴 lida em produção: AnalyticsRepository
  'public.v_worker_registration_overview', // 🔴 lida em produção: AnalyticsRepository
  'public.v_workers_current_employment',
  'public.workers_docs_expiry_alert', // 🔴 lida em produção: AuditRepositories
  'public.workers_profession_divergence',
  'public.workers_without_users',
];

describe('privilégios do papel de runtime nos schemas da aplicação (banco real)', () => {
  let pool: Pool;
  let excecoes: Set<string>;
  const LOGIN = { app_runtime: 'invpriv_runtime', app_system: 'invpriv_system' } as const;
  const SENHA = 'invpriv_e2e_pw';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const papel of PAPEIS) await ensureLoginRole(pool, LOGIN[papel], SENHA, papel);
    // As exceções de TABELA são as 2 trilhas + as partições DELAS, derivadas do catálogo (não por nome).
    const { rows } = await pool.query<{ nome: string }>(
      `SELECT n.nspname || '.' || c.relname AS nome FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1)
        UNION
       SELECT n.nspname || '.' || c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent = ANY($1::regclass[])`,
      [TRILHAS],
    );
    excecoes = new Set(rows.map((r) => r.nome));
  });

  afterAll(async () => {
    await dropLoginRoles(pool, Object.values(LOGIN));
    await pool.end();
  });

  /** `has_*_privilege` avaliado antes do filtro de schema derruba a query de sequências (`geometry_dump` não é sequência) — `OFFSET 0` materializa. */
  async function semPrivilegio(papel: string, relkinds: string[], priv: 'SELECT' | 'INSERT'): Promise<string[]> {
    const { rows } = await pool.query<{ nome: string }>(
      `SELECT nome FROM (
         SELECT c.oid, n.nspname || '.' || c.relname AS nome
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind = ANY($2) OFFSET 0
       ) t WHERE NOT has_table_privilege($3, t.oid, $4) ORDER BY nome`,
      [SCHEMAS, relkinds, papel, priv],
    );
    return rows.map((r) => r.nome);
  }

  it.each(PAPEIS)('🔒 %s LÊ DE VERDADE uma tabela de cada schema (pega USAGE + SELECT; a régua de catálogo sozinha é cega ao USAGE)', async (papel) => {
    const cliente = new Pool({ connectionString: urlFor(DATABASE_URL, LOGIN[papel], SENHA), max: 1 });
    try {
      for (const [schema, tabela] of [['public', 'patients'], ['iam', 'permissions'], ['terminology', 'icd_entities']]) {
        await expect(cliente.query(`SELECT 1 FROM ${schema}.${tabela} LIMIT 1`)).resolves.toBeDefined();
      }
    } finally {
      await cliente.end();
    }
  });

  it.each(PAPEIS)('%s tem USAGE em todos os schemas da aplicação', async (papel) => {
    const { rows } = await pool.query<{ schema: string; usage: boolean }>(
      `SELECT s AS schema, has_schema_privilege($1, s, 'USAGE') AS usage FROM unnest($2::text[]) s ORDER BY s`,
      [papel, SCHEMAS],
    );
    expect(rows.filter((r) => !r.usage).map((r) => r.schema)).toEqual([]);
    expect(rows).toHaveLength(SCHEMAS.length);
  });

  it.each(PAPEIS)('%s LÊ toda TABELA dos schemas do app — só as trilhas append-only (e suas partições) ficam de fora', async (papel) => {
    expect((await semPrivilegio(papel, ['r', 'p'], 'SELECT')).filter((t) => !excecoes.has(t))).toEqual([]);
  });

  it.each(PAPEIS)('%s: as trilhas são exceção DELIBERADA — escreve, não lê', async (papel) => {
    const semLeitura = await semPrivilegio(papel, ['r', 'p'], 'SELECT');
    const semEscrita = await semPrivilegio(papel, ['r', 'p'], 'INSERT');
    for (const t of TRILHAS) {
      expect({ t, naoLe: semLeitura.includes(t), naoEscreve: semEscrita.includes(t) })
        .toEqual({ t, naoLe: true, naoEscreve: false });
    }
  });

  it('🔒 a lista de exceções NÃO pode ser esticada: toda tabela sem SELECT pertence a uma família append-only PARTICIONADA', async () => {
    // Defesa ESTRUTURAL, não nominal: acrescentar uma tabela comum a `TRILHAS` para calar o teste
    // não funciona, porque a mãe da família tem de ser `relkind='p'` (trilha particionada por mês).
    const semLeitura = await semPrivilegio('app_runtime', ['r', 'p'], 'SELECT');
    const { rows } = await pool.query<{ familia: string }>(
      `SELECT COALESCE(
                (SELECT pn.nspname || '.' || p.relname FROM pg_inherits i
                   JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = p.relnamespace
                  WHERE i.inhrelid = c.oid),
                n.nspname || '.' || c.relname) AS familia
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1)`,
      [semLeitura],
    );
    const familias = [...new Set(rows.map((r) => r.familia))].sort();
    expect(familias).toEqual([...TRILHAS].sort());
    const { rows: maes } = await pool.query<{ nome: string; relkind: string }>(
      `SELECT n.nspname || '.' || c.relname AS nome, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1) ORDER BY 1`, [familias]);
    expect(maes.map((m) => ({ nome: m.nome, particionada: m.relkind === 'p' })))
      .toEqual(familias.map((nome) => ({ nome, particionada: true })));
  });

  it.each(PAPEIS)('%s: VIEWS sem grant são exatamente a dívida medida em 09/09 — nem uma a mais', async (papel) => {
    expect(await semPrivilegio(papel, ['v', 'm'], 'SELECT')).toEqual(DIVIDA_VIEWS_SEM_GRANT);
  });

  it.each(PAPEIS)('%s usa toda sequência dos schemas do app (INSERT com id serial não quebra)', async (papel) => {
    const { rows } = await pool.query<{ nome: string }>(
      `SELECT nome FROM (
         SELECT c.oid, n.nspname || '.' || c.relname AS nome FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind = 'S' OFFSET 0
       ) s WHERE NOT has_sequence_privilege($2, s.oid, 'USAGE') ORDER BY nome`,
      [SCHEMAS, papel],
    );
    expect(rows.map((r) => r.nome)).toEqual([]);
  });

  it('a régua está MEDINDO: contagem por schema acima do piso (schema fora da varredura não passa despercebido)', async () => {
    const { rows } = await pool.query<{ schema: string; n: number }>(
      `SELECT n.nspname AS schema, count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') GROUP BY 1 ORDER BY 1`, [SCHEMAS]);
    expect(rows.map((r) => r.schema)).toEqual([...SCHEMAS].sort());
    for (const { schema, n } of rows) expect({ schema, acimaDoPiso: n >= PISO_POR_SCHEMA[schema] }).toEqual({ schema, acimaDoPiso: true });
  });

  it('🔒 controle positivo (D157): REVOKE de SELECT e REVOKE de USAGE — os DOIS fazem a régua acusar (em transação, com ROLLBACK)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('REVOKE SELECT ON public.patients FROM app_runtime');
      const { rows: semSelect } = await client.query<{ nome: string }>(
        `SELECT nome FROM (SELECT c.oid, n.nspname||'.'||c.relname AS nome FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') OFFSET 0) t
          WHERE NOT has_table_privilege('app_runtime', t.oid, 'SELECT') ORDER BY nome`, [SCHEMAS]);
      expect(semSelect.map((r) => r.nome).filter((t) => !excecoes.has(t))).toEqual(['public.patients']);

      // o caso da D303: só o USAGE do schema cai — a régua de TABELA é cega a isto, a de schema não
      await client.query('REVOKE USAGE ON SCHEMA terminology FROM app_runtime');
      const { rows: [{ usage, tabela }] } = await client.query<{ usage: boolean; tabela: boolean }>(
        `SELECT has_schema_privilege('app_runtime','terminology','USAGE') AS usage,
                has_table_privilege('app_runtime','terminology.icd_entities','SELECT') AS tabela`);
      expect({ usage, tabela }).toEqual({ usage: false, tabela: true });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // fora da transação o mundo está íntegro (se o ROLLBACK falhasse, estas duas acusariam)
    expect((await semPrivilegio('app_runtime', ['r', 'p'], 'SELECT')).filter((t) => !excecoes.has(t))).toEqual([]);
    const { rows: [{ u }] } = await pool.query<{ u: boolean }>(`SELECT has_schema_privilege('app_runtime','terminology','USAGE') AS u`);
    expect(u).toBe(true);
  });
});
