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

/**
 * Ordem de aplicação: pelo PREFIXO NUMÉRICO, não pelo nome.
 * Hoje é no-op (as 337 migrations têm 3 dígitos), e é exatamente por isso que a troca é barata:
 * com `.sort()` lexicográfico, a primeira `1000_` seria aplicada ANTES da `323_` — silenciosamente,
 * numa ordem que nenhuma review pega. Empate (mesmo número) cai no nome com comparação CRUA (`<`),
 * NUNCA `localeCompare`: há duas `040_consolidate_clickup_columns*.sql` no repo e a colação de locale
 * as inverte — trocar a ordem de migrations já aplicadas é a mudança silenciosa que este arquivo não
 * pode fazer (medido pelo próprio teste, que reprovou a 1ª versão).
 */
function sortMigrationFiles(files) {
  const num = (f) => {
    const m = /^(\d+)_/.exec(f);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; // sem prefixo numérico: por último, pelo nome
  };
  return [...files].sort((a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `RAISE WARNING`/`NOTICE` de dentro de uma migration só chega ao log se ALGUÉM escutar: o `pg`
 * emite o evento `notice` e, sem listener, o Node o descarta. Medido em 09/09/2026 (gate da 419):
 * a 273 promete por escrito que o aviso "aparece no log de deploy" para o caso em que ela não
 * consegue conceder — e não aparecia. Migration que passa sem fazer o que diz é o pior dos mundos:
 * fica registrada como aplicada e não volta a rodar.
 *
 * ⚠️ DEVOLVE o desligamento, e quem chama TEM de usá-lo: `pool.connect()` entrega o MESMO client de
 * volta a cada migration e `release()` não tira handler nenhum. Sem o `detach`, um banco novo (1º boot,
 * stack do CI) acumula um listener por migration — o aviso da última sai N vezes, N-1 delas NOMEANDO A
 * MIGRATION ERRADA, mais `MaxListenersExceededWarning` no log. Seria piorar o log em vez de consertá-lo.
 * Medido pelo gate em 09/09/2026 (iteração 30 → 30 listeners no mesmo client).
 */
function attachNoticeLogger(client, file) {
  const handler = (n) => {
    const onde = file ? ` (${file})` : '';
    console.warn(`⚠️  [${n.severity || 'NOTICE'}]${onde} ${n.message || '(sem mensagem)'}${n.hint ? ` — ${n.hint}` : ''}`);
  };
  client.on('notice', handler);
  return () => client.removeListener('notice', handler);
}

function createPool() {
  // Cloud Run: DB_HOST is a unix socket path like /cloudsql/project:region:instance
  if (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/')) {
    // Migrations precisam do OWNER das tabelas (ALTER TABLE, DROP POLICY, SET SCHEMA,
    // CREATE FUNCTION SECURITY DEFINER, INSERT em schema_migrations — todos exigem
    // ownership). Desde a virada do ABAC (D112) o serviço conecta como enlite_runtime
    // (confinado, não-owner) — se o runner usasse essa credencial, a 1ª migration
    // com DDL de owner quebraria o boot (achado 16/08, PR #223). Por isso o runner
    // usa DB_MIGRATION_USER/DB_MIGRATION_PASSWORD (= enlite_app) quando existirem, e
    // cai em DB_USER/DB_PASSWORD onde ainda não há separação (prod hoje, local).
    const user = process.env.DB_MIGRATION_USER || process.env.DB_USER;
    const password = process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD;
    if (process.env.DB_MIGRATION_USER) {
      console.log(`[migrations] conectando como ${user} (DB_MIGRATION_USER, credencial de owner)`);
    } else {
      console.log(`[migrations] conectando como ${user} (DB_USER — sem DB_MIGRATION_USER definido)`);
    }
    return new Pool({
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      user,
      password,
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

    // Advisory lock serializa instâncias concorrentes (Cloud Run sobe N; worker-functions
    // e MCP compartilham a imagem). BLOQUEANTE de propósito, com teto (achado do gate #223,
    // reforçado pelo #326 no `main` — sync `main`→`stage` de 19/09/2026 manteve a versão do
    // `main` aqui por ser um superconjunto estrito da proteção da stage): com `try_lock` sem
    // espera a instância perdedora pulava e subia o app com o schema a meio (ex.:
    // iam.effective_countries ainda inexistente). Agora ela ESPERA o vencedor terminar e
    // relê schema_migrations — sobe só com o schema completo, com um teto de espera e um
    // fail-closed explícito quando o teto estoura E ainda há migration pendente.
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
      // Load already-applied migrations (APÓS o lock: o vencedor pode ter aplicado tudo)
      const { rows } = await pool.query('SELECT filename FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.filename));

      // Ordem de aplicação pelo PREFIXO NUMÉRICO (ver sortMigrationFiles)
      const files = sortMigrationFiles(
        fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
      );

      let ran = 0;
      let skipped = 0;

      for (const file of files) {
        if (applied.has(file)) {
          skipped++;
          continue;
        }

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

        const client = await pool.connect();
        const pararDeEscutar = attachNoticeLogger(client, file);
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
          pararDeEscutar(); // ANTES do release: o client volta ao pool sem o handler desta migration
          client.release();
        }
      }

      console.log(`\n🎉 Migrations complete — ${ran} applied, ${skipped} skipped.`);
    } finally {
      // `pool.query` (não um client dedicado): o lock foi tomado via `pool.query` acima
      // (main, PR #326) — sem `.connect()` próprio não há sessão fixa para prender o
      // lock/unlock, mas o `pool.end()` do finally externo fecha toda conexão aberta
      // logo em seguida, o que já libera qualquer advisory lock remanescente por sessão
      // encerrada. `.catch` aqui é só para não mascarar o erro real de uma migration
      // com um erro de unlock.
      await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration runner error:', err);
    process.exit(1);
  });
}

module.exports = { sortMigrationFiles, attachNoticeLogger };
