/**
 * run-migrations-lock.integration.test.ts
 *
 * Banco REAL. O runner de migrations roda no CMD do Dockerfile em TODO boot do
 * Cloud Run (`node scripts/run-migrations-docker.js && npm start`). Este arquivo
 * cobre o que acontece quando ele NÃO consegue o advisory lock.
 *
 * POR QUE EXISTE (09/09/2026, gate do PR #326)
 * A versão anterior fazia `return` ao perder o lock — retornando SUCESSO. O `&&`
 * do Dockerfile deixava o `npm start` subir, e essa instância passava a servir
 * tráfego com o SCHEMA VELHO. Num deploy que muda schema e código juntos, o write
 * path do código novo morre contra a tabela antiga.
 *
 * No caso que motivou tudo isto, esse write path é o INSERT de quem TENTOU se
 * candidatar — e `RecordBlockedAttemptUseCase` é fire-and-forget: a tentativa
 * sumiria sem 500, sem alerta, sem ninguém saber. Container que não sobe é
 * incidente visível; container que sobe com schema errado é dado perdido em
 * silêncio.
 *
 * ⚠️ O teste executa o runner REAL como processo filho, com o mesmo comando do
 * Dockerfile — asserção sobre `exit code`, não sobre a função importada. É o exit
 * code que decide se o `npm start` roda.
 */

import { Pool } from 'pg';
import { spawnSync } from 'child_process';
import * as path from 'path';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** Mesmo id do runner. Se ele mudar lá, este teste para de medir — e é o ponto. */
const LOCK_ID = 20241201;
const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'run-migrations-docker.js');

/** Roda o runner exatamente como o CMD do Dockerfile, e devolve o exit code. */
function rodarRunner(): { code: number; saida: string } {
  const r = spawnSync('node', [RUNNER], {
    // 6s em vez dos 120s de produção: o ramo sob teste é o ABORTO, e esperar dois
    // minutos por ele só tornaria o teste caro o bastante para alguém desligar.
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, MIGRATIONS_LOCK_WAIT_MS: '6000' },
    encoding: 'utf8',
    timeout: 240_000,
  });
  return { code: r.status ?? -1, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('run-migrations-docker — perder o advisory lock NÃO pode virar sucesso', () => {
  let bloqueador: Pool;

  beforeAll(async () => {
    bloqueador = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    // Garante que a tabela de controle existe antes de qualquer asserção.
    await bloqueador.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )`);
  });

  afterAll(async () => {
    await bloqueador.query('SELECT pg_advisory_unlock_all()');
    await bloqueador.end();
  });

  it('com o lock LIVRE, aplica o que falta e sai 0 (o caminho de todo boot)', () => {
    const { code, saida } = rodarRunner();
    expect(code).toBe(0);
    expect(saida).toContain('Migrations complete');
  });

  it('com o lock OCUPADO e NADA pendente, sobe — esperar não é falhar', async () => {
    // Pré-condição: a chamada acima já aplicou tudo. Medida, não presumida.
    const { rows } = await bloqueador.query<{ pendentes: string }>(
      `SELECT (SELECT count(*) FROM schema_migrations)::text AS pendentes`,
    );
    expect(Number(rows[0].pendentes)).toBeGreaterThan(0);

    await bloqueador.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      const { code, saida } = rodarRunner();
      expect(code).toBe(0);
      expect(saida).toContain('nenhuma migration pendente');
    } finally {
      await bloqueador.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  });

  it('com o lock OCUPADO e migration PENDENTE, ABORTA — nunca serve tráfego com schema velho', async () => {
    // Cria a pendência apagando um registro: o arquivo continua no disco, então o
    // runner o vê como "falta aplicar". Não toca no schema real.
    const { rows } = await bloqueador.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`,
    );
    const alvo = rows[0].filename;
    await bloqueador.query('DELETE FROM schema_migrations WHERE filename = $1', [alvo]);

    await bloqueador.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      const { code, saida } = rodarRunner();

      // O assert que importa: exit ≠ 0 é o que impede o `&&` de rodar o npm start.
      expect(code).not.toBe(0);
      expect(saida).toContain('migration(s) pendente(s)');
      expect(saida).toContain('Abortando');
    } finally {
      await bloqueador.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      await bloqueador.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [alvo],
      );
    }
  });
});
