/**
 * O runner de migrations é honesto? (banco real, 09/09/2026 — LISTA da 419)
 *
 * Duas promessas que o repo faz por escrito e que ninguém media:
 *   1. `RAISE WARNING` de dentro de uma migration "aparece no log de deploy" (273:28). Não aparecia:
 *      o `pg` emite o evento `notice` e, SEM listener, o Node o descarta. Efeito: migration que passa
 *      sem fazer o que diz fica registrada como aplicada e não volta a rodar — foi o risco real da 419.
 *   2. As migrations rodam "sorted alphabetically (stable order)". Verdade só enquanto todo prefixo tem
 *      3 dígitos: a primeira `1000_` seria aplicada ANTES da `323_`.
 *
 * Aqui o alvo é o CÓDIGO DO RUNNER (`scripts/run-migrations-docker.js`), importado — a guarda
 * `require.main === module` existe para que importar não dispare as migrations.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Pool, type PoolClient } from 'pg';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require('../../scripts/run-migrations-docker.js') as {
  sortMigrationFiles: (files: string[]) => string[];
  attachNoticeLogger: (client: PoolClient, file?: string) => () => void;
};

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('runner de migrations — avisos visíveis e ordem numérica (banco real)', () => {
  let pool: Pool;

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });

  it('🔒 `RAISE WARNING` de uma migration CHEGA ao log (sem o listener, o Node descarta em silêncio)', async () => {
    const SQL = `DO $$ BEGIN RAISE WARNING '[teste] concessão pendente — nada foi concedido'; END $$;`;

    // (a) controle POSITIVO da régua: sem listener, o aviso não aparece em lugar nenhum.
    const mudo = await pool.connect();
    const semListener: string[] = [];
    const espiao = () => semListener.push('x'); // só para provar que o evento EXISTE
    mudo.on('notice', espiao);
    await mudo.query(SQL);
    mudo.removeListener('notice', espiao); // o client é REUSADO pelo pool: deixar colado contamina o teste seguinte (medido)
    mudo.release();
    expect(semListener).toHaveLength(1); // o Postgres manda; quem não escuta, perde

    // (b) o runner escuta e IMPRIME — com a severidade e o arquivo.
    const client = await pool.connect();
    const avisos: string[] = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { avisos.push(args.join(' ')); });
    const parar = runner.attachNoticeLogger(client, '999_teste.sql');
    try {
      await client.query(SQL);
      await new Promise((r) => setTimeout(r, 50)); // o evento `notice` é assíncrono
    } finally {
      spy.mockRestore();
      parar(); // o client volta ao pool sem o handler — sem isto, ele avisaria no teste SEGUINTE (medido)
      client.release();
    }
    expect(avisos.join('\n')).toContain('concessão pendente');
    expect(avisos.join('\n')).toContain('WARNING');
    expect(avisos.join('\n')).toContain('999_teste.sql');
  });

  it('🔒 o aviso é atribuído à migration CERTA: o client volta ao pool SEM o handler (senão o log culpa a anterior)', async () => {
    // `pool.connect()` devolve o MESMO client a cada iteração; sem o `detach` do `attachNoticeLogger`,
    // um banco novo acumula um listener por migration e o aviso da última sai N vezes, N-1 delas com o
    // nome errado. Aqui o laço do runner é reproduzido com 3 "migrations", só a 3ª avisando.
    const avisos: string[] = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { avisos.push(args.join(' ')); });
    let listenersNoFim = 0;
    try {
      for (const [i, file] of ['100_a.sql', '101_b.sql', '102_c.sql'].entries()) {
        const client = await pool.connect();
        const parar = runner.attachNoticeLogger(client, file);
        try {
          if (i === 2) await client.query(`DO $$ BEGIN RAISE WARNING 'só a terceira avisa'; END $$;`);
          else await client.query('SELECT 1');
          await new Promise((r) => setTimeout(r, 20));
        } finally {
          listenersNoFim = client.listenerCount('notice');
          parar();
          client.release();
        }
      }
    } finally {
      spy.mockRestore();
    }
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('102_c.sql');
    expect(avisos[0]).not.toContain('100_a.sql');
    expect(listenersNoFim).toBe(1); // um por migration enquanto ela roda — nunca acumulado
  });

  it('🔒 importar o runner NÃO dispara migrations (guarda `require.main === module`)', () => {
    // Sem a guarda, `require()` chama `run()`: num banco limpo, aplicaria as 337 como efeito colateral de
    // um teste. Com DATABASE_URL para uma porta morta, a diferença é observável — o filho sai limpo em vez
    // de ficar tentando conectar.
    const saida = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(join(__dirname, '../../scripts/run-migrations-docker.js'))}); console.log('IMPORT_LIMPO');`],
      { env: { ...process.env, DATABASE_URL: 'postgresql://x:x@127.0.0.1:59999/nao_existe' }, timeout: 10_000, encoding: 'utf8' });
    expect(saida).toContain('IMPORT_LIMPO');
    expect(saida).not.toContain('DB not ready'); // sinal de que `run()` começou
    expect(saida).not.toContain('Migration lock acquired');
  });

  it('ordem é pelo NÚMERO, não pelo nome: `1000_` depois da `419_`; sem prefixo vai para o fim', () => {
    expect(runner.sortMigrationFiles(['419_b.sql', '1000_z.sql', '323_a.sql', '0099_x.sql', 'zz_sem_prefixo.sql']))
      .toEqual(['0099_x.sql', '323_a.sql', '419_b.sql', '1000_z.sql', 'zz_sem_prefixo.sql']);
    // empate no número cai no nome (estável, como o `.sort()` de antes)
    expect(runner.sortMigrationFiles(['323_b.sql', '323_a.sql'])).toEqual(['323_a.sql', '323_b.sql']);
  });

  it('a ordem REAL do disco não muda hoje (todas as migrations têm 3 dígitos) — a troca é no-op medido', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const files = fs.readdirSync(path.join(__dirname, '../../migrations')).filter((f) => f.endsWith('.sql'));
    expect(runner.sortMigrationFiles(files)).toEqual([...files].sort());
    // e é no-op só ENQUANTO isto valer — a premissa fica medida, não suposta
    expect(files.filter((f) => !/^\d{3}_/.test(f))).toEqual([]);
  });
});
