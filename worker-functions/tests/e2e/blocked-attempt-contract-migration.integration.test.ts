/**
 * blocked-attempt-contract-migration.integration.test.ts
 *
 * Banco REAL, DESCARTÁVEL. Cobre a metade CONTRACT do expand/contract do rename
 * honesto (`migrations/pending/CONTRACT_drop_blocked_attempt_old_columns.sql`).
 *
 * POR QUE UM BANCO SÓ DELE
 * A CONTRACT DROPA `blocked_reason` e `missing_fields`. Rodá-la no banco `enlite_e2e`
 * compartilhado derrubaria as colunas debaixo de todos os testes irmãos da suíte —
 * que é exatamente o erro de "rodei só o meu teste" que este PR já cometeu uma vez.
 * Então cada `it` cria um database próprio e aplica as migrations REAIS nele.
 *
 * POR QUE NÃO MONTAR A TABELA À MÃO
 * Fixture escrita por mim confirma a MINHA suposição (D187). O defeito mais caro
 * daqui — o `DEFAULT '[]'` da coluna ANTIGA fazendo a linha da revisão nova nascer
 * `'[]'` em vez de NULL — só apareceu porque o schema veio do runner de verdade.
 *
 * O QUE ESTÁ SENDO FIXADO
 * Durante a janela do rolling deploy, revisão velha e nova escrevem colunas
 * DIFERENTES da mesma tabela e nenhuma deixa marca de quem escreveu por último.
 * O NULL é a única marca de "esta coluna não foi tocada nesta janela" — e é por
 * isso que a 332 tem de derrubar o DEFAULT da coluna antiga junto com o NOT NULL.
 */

import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'run-migrations-docker.js');
const CONTRACT = path.join(
  __dirname, '..', '..', 'migrations', 'pending',
  'CONTRACT_drop_blocked_attempt_old_columns.sql',
);

const urlPara = (db: string): string => {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

/** Cria um database descartável e aplica TODAS as migrations reais nele. */
async function bancoDescartavel(sufixo: string): Promise<{ url: string; pool: Pool; destruir: () => Promise<void> }> {
  const nome = `contract_test_${sufixo}_${Date.now()}`;
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${nome}`);
  const url = urlPara(nome);

  execFileSync('node', [RUNNER], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });

  const pool = new Pool({ connectionString: url, max: 1 });
  return {
    url,
    pool,
    destruir: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Roda a CONTRACT via psql, como `run-migration-prod.sh` faz. Devolve o exit code. */
function rodarContract(url: string): { code: number; saida: string } {
  const sql = fs.readFileSync(CONTRACT, 'utf8');
  try {
    const out = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse'], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, saida: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, saida: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const VAGA = 'bbbb2222-0000-0000-0000-0000000000f1';

async function semear(pool: Pool, sufixo: string): Promise<string> {
  const worker = `aaaa1111-0000-0000-0000-0000000${sufixo}`;
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, status, country)
     VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR')`,
    [worker, `u${sufixo}`, `u${sufixo}@contract.test`],
  );
  return worker;
}

describe('CONTRACT do rename honesto — a janela do rolling deploy', () => {
  jest.setTimeout(180_000);

  it('preserva as 3 formas de linha da janela e é re-executável', async () => {
    const db = await bancoDescartavel('ok');
    try {
      await db.pool.query(
        `INSERT INTO job_postings (id, case_number, vacancy_number, title, status, is_draft)
         VALUES ($1, 7001, 1, 'C', 'SEARCHING', false)`, [VAGA],
      );
      // 1. histórica: a 332 backfillou, as duas colunas iguais
      const w1 = await semear(db.pool, '00001');
      await db.pool.query(
        `INSERT INTO worker_blocked_applications
           (worker_id, job_posting_id, blocked_reason, missing_fields,
            blocked_reason_at_attempt, missing_fields_at_attempt)
         VALUES ($1,$2,'registration_incomplete','["phone"]','registration_incomplete','["phone"]')`,
        [w1, VAGA],
      );
      // 2. revisão NOVA escreveu na janela → coluna ANTIGA fica NULL.
      //    🔒 Só fica NULL porque a 332 derruba o DEFAULT '[]' da coluna antiga.
      //    Com o DEFAULT de pé, esta linha nasce `'[]'` e a checagem de ambiguidade
      //    aborta numa linha perfeitamente normal. Foi assim que o defeito apareceu.
      const w2 = await semear(db.pool, '00002');
      await db.pool.query(
        `INSERT INTO worker_blocked_applications
           (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt)
         VALUES ($1,$2,'worker_disabled','["first_name"]')`, [w2, VAGA],
      );
      // 3. revisão VELHA escreveu na janela → coluna NOVA fica NULL
      const w3 = await semear(db.pool, '00003');
      await db.pool.query(
        `INSERT INTO worker_blocked_applications
           (worker_id, job_posting_id, blocked_reason, missing_fields)
         VALUES ($1,$2,'worker_not_found','["phone","first_name"]')`, [w3, VAGA],
      );

      const primeira = rodarContract(db.url);
      expect(primeira.code).toBe(0);

      const esperado = [
        [w1, 'registration_incomplete', ['phone']],
        [w2, 'worker_disabled', ['first_name']],
        [w3, 'worker_not_found', ['phone', 'first_name']],
      ] as const;

      const conferir = async (quando: string) => {
        for (const [id, motivo, campos] of esperado) {
          const { rows } = await db.pool.query(
            `SELECT blocked_reason_at_attempt AS m, missing_fields_at_attempt AS c
               FROM worker_blocked_applications WHERE worker_id = $1`, [id],
          );
          expect(`${quando}:${rows[0].m}`).toBe(`${quando}:${motivo}`);
          expect(rows[0].c).toEqual([...campos]);
        }
      };
      await conferir('1a');

      // As colunas antigas se foram — é o ponto da migration.
      const { rows: cols } = await db.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'worker_blocked_applications'
            AND column_name IN ('blocked_reason', 'missing_fields')`,
      );
      expect(cols).toHaveLength(0);

      // 🔒 Re-execução. `run-migration-prod.sh` NÃO escreve em `schema_migrations`,
      // então assim que este arquivo for movido para `migrations/` o runner o vê como
      // pendente e o re-roda no próximo boot. Como o runner agora falha FECHADO, um
      // erro aqui não é barulho: é nenhuma instância subindo.
      const segunda = rodarContract(db.url);
      expect(segunda.code).toBe(0);
      await conferir('2a');
    } finally {
      await db.destruir();
    }
  });

  it('ABORTA quando as duas colunas divergem — não escolhe uma no chute', async () => {
    const db = await bancoDescartavel('ambiguo');
    try {
      await db.pool.query(
        `INSERT INTO job_postings (id, case_number, vacancy_number, title, status, is_draft)
         VALUES ($1, 7002, 1, 'C', 'SEARCHING', false)`, [VAGA],
      );
      // A 332 backfillou 'registration_incomplete'; depois, ainda na janela, a
      // revisão VELHA registrou nova tentativa e gravou 'worker_disabled' só na
      // coluna antiga. Não há como saber qual é a mais recente.
      const w = await semear(db.pool, '0000f');
      await db.pool.query(
        `INSERT INTO worker_blocked_applications
           (worker_id, job_posting_id, blocked_reason, missing_fields,
            blocked_reason_at_attempt, missing_fields_at_attempt)
         VALUES ($1,$2,'worker_disabled','[]','registration_incomplete','["phone"]')`,
        [w, VAGA],
      );

      const r = rodarContract(db.url);
      expect(r.code).not.toBe(0);
      expect(r.saida).toContain('ABORTADO');

      // O que importa depois do aborto: NADA foi destruído. As duas colunas
      // continuam de pé com os dois valores, para um humano comparar e decidir.
      const { rows: cols } = await db.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'worker_blocked_applications'
            AND column_name IN ('blocked_reason', 'missing_fields')`,
      );
      expect(cols).toHaveLength(2);

      const { rows } = await db.pool.query(
        `SELECT blocked_reason AS antiga, blocked_reason_at_attempt AS nova
           FROM worker_blocked_applications WHERE worker_id = $1`, [w],
      );
      expect(rows[0].antiga).toBe('worker_disabled');
      expect(rows[0].nova).toBe('registration_incomplete');
    } finally {
      await db.destruir();
    }
  });
});
