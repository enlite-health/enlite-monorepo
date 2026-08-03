/**
 * Prova E2E contra Postgres REAL (não mock): o replaceByWorkerId é atômico.
 *
 * Cenário do bug de produção (03/08, Mariana Díaz `26fd593d`): worker tinha
 * disponibilidade salva; um save com payload inválido (slot duplicado ou
 * fim<=início) commitava o DELETE e falhava o INSERT em outra transação →
 * disponibilidade destruída → worker caía de REGISTERED.
 *
 * Este script reproduz a tabela real (mesmas constraints unique_worker_day_time
 * e valid_time_range) e verifica que, com o replaceByWorkerId:
 *   1. insert violando UNIQUE → slots anteriores INTACTOS;
 *   2. insert violando CHECK valid_time_range → slots anteriores INTACTOS;
 *   3. payload válido → substituição normal.
 *
 * Uso: DATABASE_URL=postgres://... npx ts-node scripts/proof-replace-availability.ts
 */
import { Pool } from 'pg';

const DDL = `
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  DROP TABLE IF EXISTS worker_availability;
  CREATE TABLE worker_availability (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    worker_id uuid NOT NULL,
    day_of_week integer NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    timezone varchar(50) NOT NULL,
    crosses_midnight boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT unique_worker_day_time UNIQUE (worker_id, day_of_week, start_time, end_time),
    CONSTRAINT valid_day CHECK (day_of_week >= 0 AND day_of_week <= 6),
    CONSTRAINT valid_time_range CHECK (crosses_midnight = true OR end_time > start_time)
  );
`;

const WORKER = '26fd593d-85aa-4ad3-bfe8-000000000000';

// Mesma lógica do AvailabilityRepository.replaceByWorkerId (copiada aqui porque o
// repositório de produção amarra no singleton DatabaseConnection).
async function replaceByWorkerId(
  pool: Pool,
  workerId: string,
  slots: Array<{ dayOfWeek: number; startTime: string; endTime: string; crossesMidnight?: boolean }>,
): Promise<{ ok: boolean; error?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [workerId]);
    for (const slot of slots) {
      await client.query(
        `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone, crosses_midnight)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [workerId, slot.dayOfWeek, slot.startTime, slot.endTime, 'America/Argentina/Buenos_Aires', slot.crossesMidnight || false],
      );
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error: any) {
    await client.query('ROLLBACK');
    return { ok: false, error: error.message };
  } finally {
    client.release();
  }
}

async function count(pool: Pool): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM worker_availability WHERE worker_id = $1`, [WORKER]);
  return r.rows[0].n;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(DDL);

  let failed = 0;
  const check = (name: string, cond: boolean, detail: string): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'} — ${name} (${detail})`);
    if (!cond) failed++;
  };

  // Estado inicial: 2 slots válidos salvos
  const seed = await replaceByWorkerId(pool, WORKER, [
    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
    { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
  ]);
  check('seed válido grava', seed.ok && (await count(pool)) === 2, `count=${await count(pool)}`);

  // 1. Payload violando UNIQUE (duplo toque no "+"): slots antigos intactos
  const dup = await replaceByWorkerId(pool, WORKER, [
    { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
    { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
  ]);
  check('UNIQUE violado → falha SEM wipe', !dup.ok && (await count(pool)) === 2, `error=${dup.error}; count=${await count(pool)}`);

  // 2. Payload violando CHECK valid_time_range: slots antigos intactos
  const range = await replaceByWorkerId(pool, WORKER, [
    { dayOfWeek: 4, startTime: '20:00', endTime: '08:00' },
  ]);
  check('CHECK violado → falha SEM wipe', !range.ok && (await count(pool)) === 2, `error=${range.error}; count=${await count(pool)}`);

  // 3. Payload válido substitui normalmente
  const ok = await replaceByWorkerId(pool, WORKER, [
    { dayOfWeek: 5, startTime: '10:00', endTime: '14:00' },
  ]);
  check('payload válido substitui', ok.ok && (await count(pool)) === 1, `count=${await count(pool)}`);

  // 4. Contraste com o comportamento ANTIGO (2 transações): prova que o bug era esse
  await pool.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [WORKER]);
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone) VALUES ($1, 1, '09:00', '17:00', 'X')`,
    [WORKER],
  );
  await pool.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [WORKER]); // transação 1 (autocommit)
  try {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone) VALUES ($1, 4, '20:00', '08:00', 'X')`,
      [WORKER],
    );
    await pool.query('COMMIT');
  } catch {
    await pool.query('ROLLBACK'); // transação 2 falha... e o delete já era
  }
  check('comportamento ANTIGO destruía (contraste)', (await count(pool)) === 0, `count=${await count(pool)} (wipe reproduzido)`);

  await pool.end();
  if (failed > 0) {
    console.error(`\n${failed} verificação(ões) FALHARAM`);
    process.exit(1);
  }
  console.log('\nTodas as verificações passaram: replaceByWorkerId é atômico contra Postgres real.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
