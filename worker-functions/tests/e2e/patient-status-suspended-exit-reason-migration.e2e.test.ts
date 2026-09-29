import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * Régua da migration 486 (decisão do Gabriel 29/09/2026): 3 transições de saída de SUSPENDED +
 * `patient_status_history.reason`/`actor_uid` + os triggers da 254/255 lendo os 2 GUCs novos.
 *
 * Lê os arquivos do disco (molde `patient-status-transitions-derivacao-migration.e2e.test.ts`):
 * `readFileSync` + query, não o runner — só assim o `down`
 * (`migrations/pending/ROLLBACK_486_…`) é exercitado. Todo `down` roda num client dedicado
 * dentro de BEGIN … ROLLBACK — o banco do teste volta como estava e nenhum par/coluna é
 * apagado por SQL solto.
 */

const MIG_DIR = join(__dirname, '..', '..', 'migrations');
const UP_SQL = readFileSync(join(MIG_DIR, '486_patient_status_suspended_exit_reason.sql'), 'utf8');
const DOWN_SQL = readFileSync(join(MIG_DIR, 'pending', 'ROLLBACK_486_patient_status_suspended_exit_reason.sql'), 'utf8');

const LIBERADAS = `(('SUSPENDED','SEARCHING'),('SUSPENDED','REPLACEMENT'),('SUSPENDED','ON_HOLD'))`;

async function contarTransicoes(q: Pool | PoolClient): Promise<number> {
  const { rows } = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM patient_status_transitions WHERE (from_status, to_status) IN ${LIBERADAS}`,
  );
  return Number(rows[0].n);
}

async function temColunas(q: Pool | PoolClient): Promise<boolean> {
  const { rows } = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'patient_status_history' AND column_name IN ('reason', 'actor_uid')`,
  );
  return Number(rows[0].n) === 2;
}

describe('migration 486 — saída de SUSPENDED com motivo + actor_uid (banco real) @integration', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('(a) as 3 transições de saída de SUSPENDED estão no catálogo', async () => {
    const liberadas = await contarTransicoes(pool);
    expect(liberadas).toBe(3);
  });

  it('(b) patient_status_history tem as colunas reason e actor_uid', async () => {
    expect(await temColunas(pool)).toBe(true);
  });

  it('(c) CHECK de reason recusa valor fora do catálogo', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country, status)
         VALUES ('e2e-486-check-' || gen_random_uuid()::text, 'AR', 'SEARCHING') RETURNING id`,
      );
      await expect(
        client.query(
          `INSERT INTO patient_status_history (patient_id, old_value, new_value, reason) VALUES ($1, 'SUSPENDED', 'SEARCHING', 'MOTIVO_INVENTADO')`,
          [rows[0].id],
        ),
      ).rejects.toThrow(/patient_status_history_reason_check/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('(d) triggers gravam reason/actor_uid a partir de app.status_reason/app.actor_uid; string vazia vira NULL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country, status)
         VALUES ('e2e-486-trigger-' || gen_random_uuid()::text, 'AR', 'SUSPENDED') RETURNING id`,
      );
      await client.query("SELECT set_config('app.change_source', 'admin_panel', true)");
      await client.query("SELECT set_config('app.status_reason', 'RESUMED_SERVICE', true)");
      await client.query("SELECT set_config('app.actor_uid', 'uid-e2e-486', true)");
      await client.query(`UPDATE patients SET status = 'SEARCHING' WHERE id = $1`, [rows[0].id]);
      // `created_at DESC` não desempata: `NOW()` é congelado no início da TRANSAÇÃO (mesmo
      // valor para a linha do INSERT-trigger e a do UPDATE-trigger, ambos na mesma transação) —
      // medido: a 1ª versão deste teste pegava a linha ERRADA por sorte de empate. Filtrar pela
      // TRANSIÇÃO (old_value/new_value), única nesta chamada, é o que realmente identifica a linha.
      const { rows: hist } = await client.query(
        `SELECT reason, actor_uid FROM patient_status_history
          WHERE patient_id = $1 AND old_value = 'SUSPENDED' AND new_value = 'SEARCHING'`,
        [rows[0].id],
      );
      expect(hist[0]).toEqual({ reason: 'RESUMED_SERVICE', actor_uid: 'uid-e2e-486' });

      // string vazia (ausência dentro da mesma transação) vira NULL via NULLIF — mesmo padrão
      // que a ausência do GUC já virava NULL antes de existir change_source.
      await client.query("SELECT set_config('app.status_reason', '', true)");
      await client.query("SELECT set_config('app.actor_uid', '', true)");
      await client.query(`UPDATE patients SET status = 'ACTIVE' WHERE id = $1`, [rows[0].id]);
      const { rows: hist2 } = await client.query(
        `SELECT reason, actor_uid FROM patient_status_history
          WHERE patient_id = $1 AND old_value = 'SEARCHING' AND new_value = 'ACTIVE'`,
        [rows[0].id],
      );
      expect(hist2[0]).toEqual({ reason: null, actor_uid: null });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('(e) o down remove as 3 transições e as 2 colunas, dentro de uma transação que volta', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(DOWN_SQL);
      const liberadasDepoisDoDown = await contarTransicoes(client);
      const colunasDepoisDoDown = await temColunas(client);
      await client.query(DOWN_SQL); // idempotente: a 2ª rodada não erra
      await client.query('ROLLBACK');
      const liberadasDepoisDoRollback = await contarTransicoes(pool);
      const colunasDepoisDoRollback = await temColunas(pool);
      expect(liberadasDepoisDoDown).toBe(0);
      expect(colunasDepoisDoDown).toBe(false);
      expect(liberadasDepoisDoRollback).toBe(3);
      expect(colunasDepoisDoRollback).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('(f) reaplicar a 486 é idempotente — segue 3 transições e as 2 colunas', async () => {
    await pool.query(UP_SQL);
    await pool.query(UP_SQL);
    expect(await contarTransicoes(pool)).toBe(3);
    expect(await temColunas(pool)).toBe(true);
  });

  it('(g) trava de dado: com reason/actor_uid já preenchido no histórico, o down recusa e não dropa as colunas', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country, status)
         VALUES ('e2e-486-trava-' || gen_random_uuid()::text, 'AR', 'SEARCHING') RETURNING id`,
      );
      await client.query(
        `INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source, reason, actor_uid)
         VALUES ($1, 'SUSPENDED', 'SEARCHING', 'admin_panel', 'RESUMED_SERVICE', 'uid-trava')`,
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
      const colunasComTrava = await temColunas(client);
      await client.query('ROLLBACK');
      expect(String((erro as Error | null)?.message)).toContain('reason/actor_uid preenchido');
      expect(colunasComTrava).toBe(true);
      expect(await temColunas(pool)).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
