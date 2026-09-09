#!/usr/bin/env node
/**
 * Idempotent migration runner for Docker/local environments.
 * Uses DATABASE_URL env var and a schema_migrations tracking table.
 * Safe to run multiple times — already-applied migrations are skipped.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function createPool() {
  // Cloud Run: DB_HOST is a unix socket path like /cloudsql/project:region:instance
  if (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/')) {
    return new Pool({
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  }
  // Docker/local: DATABASE_URL connection string
  const DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
  return new Pool({ connectionString: DATABASE_URL });
}

async function waitForDB(pool, attempts = 30, delayMs = 1000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`⏳ DB not ready (attempt ${i}/${attempts}) — ${err.code || err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function run() {
  const pool = createPool();

  try {
    await waitForDB(pool);

    // Ensure tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Advisory lock prevents race condition when Cloud Run starts multiple instances.
    //
    // 🔒 NÃO devolve sucesso ao desistir do lock, e o motivo é um dano medido
    // (09/09/2026, gate do PR #326): a versão anterior fazia `return` quando outra
    // instância segurava o lock — o `&&` do Dockerfile deixava o `npm start` subir,
    // e ESSA instância passava a servir tráfego com o SCHEMA VELHO. Com um deploy
    // que muda schema e código juntos, o write path do código novo morre contra a
    // tabela antiga. Aqui isso é o INSERT de quem TENTOU se candidatar — e o
    // `RecordBlockedAttemptUseCase` é fire-and-forget: a tentativa some sem 500,
    // sem alerta, sem ninguém saber.
    //
    // Agora: ESPERA o lock (a outra instância está aplicando, não é erro), e se o
    // tempo estourar, só sobe se NÃO houver migration pendente. Havendo pendência,
    // falha FECHADO — container que não sobe é incidente visível; container que
    // sobe com schema errado é dado perdido em silêncio.
    const LOCK_ID = 20241201; // arbitrary fixed int
    // Configurável só para o teste conseguir exercitar o ramo de aborto sem
    // esperar 2 minutos. Em produção ninguém passa a env, e o default vale.
    // 🔒 TETO MEDIDO, não escolhido no chute. O `startupProbe` do serviço em produção
    // (medido 09/09 em `enlite-prd`/`southamerica-west1`) é TCP na 8080 com
    // `timeoutSeconds: 240` e `failureThreshold: 1` — UMA falha e o contêiner morre,
    // sem retry. O orçamento até o `npm start` abrir a porta é:
    //
    //     waitForDB (até 30s) + esta espera (120s) + tempo das migrations  <  240s
    //
    // ou seja, ~90s de folga. Quem aumentar MIGRATIONS_LOCK_WAIT_MS gasta essa folga:
    // acima de ~180s o boot passa a ser morto pelo probe em vez de esperar, e aí a
    // trava que existe para não servir schema velho vira indisponibilidade.
    // `minScale: 1`, então enquanto a revisão nova não sobe a antiga segue atendendo.
    const ESPERA_MAX_MS = Number(process.env.MIGRATIONS_LOCK_WAIT_MS ?? 120_000);
    const INTERVALO_MS = 2_000;

    let temLock = false;
    const limite = Date.now() + ESPERA_MAX_MS;
    while (Date.now() < limite) {
      const r = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_ID]);
      if (r.rows[0].acquired) { temLock = true; break; }
      console.log('⏳ Outra instância está aplicando migrations — aguardando o lock...');
      await new Promise((resolve) => setTimeout(resolve, INTERVALO_MS));
    }

    if (!temLock) {
      // Última chance: se não sobrou nada para aplicar, subir é seguro.
      const { rows: aplicadas } = await pool.query('SELECT filename FROM schema_migrations');
      const jaAplicadas = new Set(aplicadas.map((r) => r.filename));
      const pendentes = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => !jaAplicadas.has(f));

      if (pendentes.length === 0) {
        console.log('✅ Lock ocupado, mas nenhuma migration pendente — seguro subir.');
        return;
      }

      // Só as 5 primeiras: a lista inteira pode ter centenas de nomes num banco
      // novo, e log ilegível é log que ninguém lê na hora do incidente.
      const amostra = pendentes.slice(0, 5).join(', ');
      const resto = pendentes.length > 5 ? ` (+${pendentes.length - 5})` : '';
      console.error(
        `❌ Não consegui o lock em ${ESPERA_MAX_MS / 1000}s e ainda há ` +
        `${pendentes.length} migration(s) pendente(s): ${amostra}${resto}.\n` +
        '   Subir agora serviria tráfego com o schema desatualizado. Abortando.',
      );
      process.exit(1);
    }

    try {
      // Load already-applied migrations
      const { rows } = await pool.query('SELECT filename FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.filename));

      // List all .sql files, sorted alphabetically (stable order)
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      let ran = 0;
      let skipped = 0;

      for (const file of files) {
        if (applied.has(file)) {
          skipped++;
          continue;
        }

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1)',
            [file]
          );
          await client.query('COMMIT');
          console.log(`✅ Applied: ${file}`);
          ran++;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ Failed: ${file}`);
          console.error(err.message);
          process.exit(1);
        } finally {
          client.release();
        }
      }

      console.log(`\n🎉 Migrations complete — ${ran} applied, ${skipped} skipped.`);
    } finally {
      await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migration runner error:', err);
  process.exit(1);
});
