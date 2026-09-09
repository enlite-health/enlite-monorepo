/**
 * O papel de RUNTIME enxerga o que a API precisa? (banco real — LISTA da 419, 09/09/2026)
 *
 * A classe de defeito que este arquivo fecha: **o CI roda a API como DONA do banco (`enlite_admin`),
 * a stage roda como `enlite_runtime` (membro de `app_runtime`, RLS ligado)**. Um schema/tabela novo
 * sem `GRANT` passa verde em toda a suíte e só aparece na stage — foi exatamente o que aconteceu com
 * o schema `terminology` (criado pela 323, concedido só à dona): `/api/admin/terminology/search`
 * respondia 503 com o catálogo carregado, e a migration 419 nasceu por isso.
 *
 * Em vez de subir um segundo stack de CI "API como runtime" (caro), o invariante mede o PRIVILÉGIO:
 * toda tabela dos schemas que a aplicação lê tem de ser legível pelos dois papéis. As exceções são
 * NOMEADAS e provadas como deliberadas (trilha append-only: escreve, não lê) — lista fechada, para
 * que a próxima tabela sem grant reprove aqui e não na stage.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** Schemas que a aplicação lê em runtime. `terminology` está aqui porque a 419 existe. */
const SCHEMAS = ['public', 'iam', 'terminology'];
const PAPEIS = ['app_runtime', 'app_system'];

/**
 * Trilhas append-only: o runtime ESCREVE e não LÊ (a leitura é do painel de auditoria, por função
 * `SECURITY DEFINER`/role própria). São exceção deliberada, não esquecimento — o teste abaixo exige
 * que cada uma seja INSERT-able, senão "sem SELECT" viraria desculpa para "sem nada".
 */
const TRILHAS = ['permission_audit_log', 'resource_access_log'];
const ehTrilha = (nome: string) => TRILHAS.some((t) => nome.includes(`.${t}`));

describe('privilégios do papel de runtime nos schemas da aplicação (banco real)', () => {
  let pool: Pool;

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });

  /** `has_table_privilege` avaliado ANTES do filtro de schema derruba a query (medido) — materializa com OFFSET 0. */
  async function semPrivilegio(papel: string, privilegio: 'SELECT' | 'INSERT'): Promise<string[]> {
    const { rows } = await pool.query<{ nome: string }>(
      `SELECT nome FROM (
         SELECT c.oid, n.nspname || '.' || c.relname AS nome
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p') OFFSET 0
       ) t WHERE NOT has_table_privilege($2, t.oid, $3) ORDER BY nome`,
      [SCHEMAS, papel, privilegio],
    );
    return rows.map((r) => r.nome);
  }

  it.each(PAPEIS)('%s LÊ toda tabela dos schemas do app — só as trilhas append-only ficam de fora', async (papel) => {
    const semLeitura = await semPrivilegio(papel, 'SELECT');
    // O que sobra depois de tirar as trilhas TEM de ser vazio: é aqui que um schema novo sem GRANT reprova.
    expect(semLeitura.filter((t) => !ehTrilha(t))).toEqual([]);
    // Contagem zero é falha, nunca sucesso: a régua só vale se ela estiver medindo tabela de verdade.
    const { rows: [{ n }] } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n2 ON n2.oid = c.relnamespace
        WHERE n2.nspname = ANY($1) AND c.relkind IN ('r','p')`, [SCHEMAS]);
    expect(n).toBeGreaterThan(100);
  });

  it.each(PAPEIS)('%s: as trilhas são exceção DELIBERADA — escreve, não lê (append-only)', async (papel) => {
    const semLeitura = await semPrivilegio(papel, 'SELECT');
    const semEscrita = await semPrivilegio(papel, 'INSERT');
    for (const t of TRILHAS) {
      // a mãe da partição: sem leitura (append-only) e COM escrita — as duas metades da exceção
      expect({ trilha: t, semLeitura: semLeitura.some((x) => x.endsWith(`.${t}`)), semEscrita: semEscrita.some((x) => x.endsWith(`.${t}`)) })
        .toEqual({ trilha: t, semLeitura: true, semEscrita: false });
    }
  });

  it.each(PAPEIS)('%s usa toda sequência dos schemas do app (INSERT com id serial não quebra)', async (papel) => {
    const { rows } = await pool.query<{ nome: string }>(
      `SELECT nome FROM (
         SELECT c.oid, n.nspname || '.' || c.relname AS nome
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind = 'S' OFFSET 0
       ) s WHERE NOT has_sequence_privilege($2, s.oid, 'USAGE') ORDER BY nome`,
      [SCHEMAS, papel],
    );
    expect(rows.map((r) => r.nome)).toEqual([]);
  });

  it('🔒 controle positivo (D157): um REVOKE numa tabela qualquer FAZ a régua acusar — em transação, com ROLLBACK', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('REVOKE SELECT ON public.patients FROM app_runtime');
      const { rows } = await client.query<{ nome: string }>(
        `SELECT nome FROM (
           SELECT c.oid, n.nspname || '.' || c.relname AS nome
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') OFFSET 0
         ) t WHERE NOT has_table_privilege('app_runtime', t.oid, 'SELECT') ORDER BY nome`,
        [SCHEMAS],
      );
      expect(rows.map((r) => r.nome).filter((t) => !ehTrilha(t))).toEqual(['public.patients']);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // e, fora da transação, o mundo continua íntegro
    expect((await semPrivilegio('app_runtime', 'SELECT')).filter((t) => !ehTrilha(t))).toEqual([]);
  });
});
