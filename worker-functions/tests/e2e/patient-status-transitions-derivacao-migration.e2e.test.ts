import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * Régua da migration 485 (cadeia Fase 15, tasks 15.1/15.2; D430): as 2 transições que a derivação
 * por horas produz e o seed da 315 não tinha — SEARCHING → REPLACEMENT e ACTIVE → SEARCHING.
 *
 * Lê os arquivos do disco (molde `grant-views-catchup-migration.e2e.test.ts`: `readFileSync` +
 * query), não pelo runner: só assim o `down` (`migrations/pending/ROLLBACK_485_…`) é exercitado.
 * Todo `down` roda num client dedicado dentro de BEGIN … ROLLBACK — o banco do teste volta como
 * estava (as 2 transições presentes) e nenhum par do catálogo é apagado por SQL solto.
 */

const MIG_DIR = join(__dirname, '..', '..', 'migrations');
const UP_SQL = readFileSync(join(MIG_DIR, '485_patient_status_transitions_derivacao.sql'), 'utf8');
const DOWN_SQL = readFileSync(join(MIG_DIR, 'pending', 'ROLLBACK_485_patient_status_transitions_derivacao.sql'), 'utf8');

const LIBERADAS = `(('SEARCHING','REPLACEMENT'),('ACTIVE','SEARCHING'))`;
const AS_OUTRAS_4 = `(('SEARCHING','ACTIVE'),('REPLACEMENT','ACTIVE'),('REPLACEMENT','SEARCHING'),('ACTIVE','REPLACEMENT'))`;
const AS_6 = `(('SEARCHING','ACTIVE'),('SEARCHING','REPLACEMENT'),('REPLACEMENT','ACTIVE'),('REPLACEMENT','SEARCHING'),('ACTIVE','REPLACEMENT'),('ACTIVE','SEARCHING'))`;

async function contar(q: Pool | PoolClient, pares: string): Promise<number> {
  const { rows } = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM patient_status_transitions WHERE (from_status, to_status) IN ${pares}`,
  );
  return Number(rows[0].n);
}

describe('migration 485 — as 2 transições da derivação por horas (banco real) @integration', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('(a) as 2 liberadas pela D430 estão no catálogo', async () => {
    const liberadas = await contar(pool, LIBERADAS);
    console.log('[15.1]', { liberadas });
    expect(liberadas).toBe(2);
  });

  it('(b) as 6 transições que a derivação produz existem', async () => {
    const seis = await contar(pool, AS_6);
    console.log('[15.2]', { seis });
    expect(seis).toBe(6);
  });

  it('(c) o down remove só as 2 (as outras 4 ficam), dentro de uma transação que volta', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(DOWN_SQL);
      const liberadasDepoisDoDown = await contar(client, LIBERADAS);
      const outras4 = await contar(client, AS_OUTRAS_4);
      await client.query(DOWN_SQL); // idempotente: a 2ª rodada não erra
      const liberadasDepoisDo2oDown = await contar(client, LIBERADAS);
      await client.query('ROLLBACK');
      const liberadasDepoisDoRollback = await contar(pool, LIBERADAS);
      console.log('[15.1]', { liberadasDepoisDoDown, outras4, liberadasDepoisDo2oDown, liberadasDepoisDoRollback });
      expect(liberadasDepoisDoDown).toBe(0);
      expect(outras4).toBe(4);
      expect(liberadasDepoisDo2oDown).toBe(0);
      expect(liberadasDepoisDoRollback).toBe(2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('(d) reaplicar a 485 é idempotente — segue 2', async () => {
    await pool.query(UP_SQL);
    await pool.query(UP_SQL);
    const liberadas = await contar(pool, LIBERADAS);
    const seis = await contar(pool, AS_6);
    console.log('[15.2]', { liberadas, seis });
    expect(liberadas).toBe(2);
    expect(seis).toBe(6);
  });

  it('(e) trava de dado: com paciente movido por um dos 2 pares no histórico, o down recusa e não remove', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country, status)
         VALUES ('e2e-485-trava-' || gen_random_uuid()::text, 'AR', 'REPLACEMENT') RETURNING id`,
      );
      await client.query(
        `INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source)
         VALUES ($1, 'SEARCHING', 'REPLACEMENT', 'system')`,
        [rows[0].id],
      );
      await client.query('SAVEPOINT antes_do_down');
      let erro: unknown = null;
      try {
        await client.query(DOWN_SQL);
      } catch (e) {
        erro = e;
      }
      await client.query('ROLLBACK TO SAVEPOINT antes_do_down');
      const liberadasComTrava = await contar(client, LIBERADAS);
      await client.query('ROLLBACK');
      console.log('[15.1]', { recusou: erro !== null, liberadasComTrava });
      expect(String((erro as Error | null)?.message)).toContain('há paciente movido por uma das transições da 485');
      expect(liberadasComTrava).toBe(2);
      expect(await contar(pool, LIBERADAS)).toBe(2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
