/**
 * T-F3c-132 / T-F3c-165 — dispensa por legado (`phone_verification_waived_at`) e a regra "completo exige celular verificado só daqui
 * em diante", contra POSTGRES REAL como `enlite_app`. A migration 594 é REAPLICADA dentro da transação do teste (é idempotente): é o
 * carimbo do corte que se mede. Tudo termina em ROLLBACK.
 */
import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';
import { novaFicha, gravarVerificacao } from './helpers/phoneVerificationFixtures';
import { recalculateStatus } from '../../src/modules/worker/infrastructure/WorkerImportRepository';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '594_phone_verification.sql'), 'utf8');

describe('dispensa por legado do celular verificado', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  async function emTransacao(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  const waived = async (c: PoolClient, id: string) =>
    (await c.query<{ w: Date | null }>(`SELECT phone_verification_waived_at AS w FROM workers WHERE id = $1`, [id])).rows[0].w;
  const aplicarMigration = async (c: PoolClient): Promise<string[]> => {
    const avisos: string[] = [];
    const h = (n: { message?: string }) => avisos.push(n.message ?? '');
    c.on('notice', h);
    await c.query(MIGRATION);
    c.removeListener('notice', h);
    return avisos;
  };
  async function semear(c: PoolClient) {
    const registered = await novaFicha(c, { status: 'REGISTERED' });
    const incomplete = await novaFicha(c, { status: 'INCOMPLETE_REGISTER' });
    const disabled = await novaFicha(c, { status: 'DISABLED' });
    const merged = await novaFicha(c, { status: 'REGISTERED' });
    await c.query(`UPDATE workers SET merged_into_id = $2 WHERE id = $1`, [merged.id, registered.id]);
    return { registered, incomplete, disabled, merged };
  }

  it('T-F3c-132 o carimbo marca só status = REGISTERED AND merged_into_id IS NULL', async () => {
    await emTransacao(async (c) => {
      const f = await semear(c);
      await aplicarMigration(c);
      expect(await waived(c, f.registered.id)).not.toBeNull();
      expect(await waived(c, f.incomplete.id)).toBeNull();
      expect(await waived(c, f.disabled.id)).toBeNull();
      expect(await waived(c, f.merged.id)).toBeNull();
    });
  });

  it('T-F3c-132 a contagem logada pela migration = linhas marcadas', async () => {
    await emTransacao(async (c) => {
      await semear(c);
      const antes = Number((await c.query(`SELECT count(*) AS n FROM workers WHERE phone_verification_waived_at IS NOT NULL`)).rows[0].n);
      const avisos = await aplicarMigration(c);
      const depois = Number((await c.query(`SELECT count(*) AS n FROM workers WHERE phone_verification_waived_at IS NOT NULL`)).rows[0].n);
      const log = avisos.find((m) => m.startsWith('migration 594:'));
      expect(log).toBeDefined();
      expect(Number(/: (\d+) fichas/.exec(log as string)?.[1])).toBe(depois - antes);
      expect(depois - antes).toBeGreaterThanOrEqual(1); // a REGISTERED viva semeada (a mesclada não conta)
    });
  });

  it('T-F3c-132 UPDATE ... SET phone_verification_waived_at = NULL falha', async () => {
    await emTransacao(async (c) => {
      const f = await novaFicha(c, { status: 'REGISTERED' });
      await aplicarMigration(c);
      await expect(c.query(`UPDATE workers SET phone_verification_waived_at = NULL WHERE id = $1`, [f.id])).rejects.toThrow(
        /não pode ser removida nem trocada/,
      );
    });
  });

  it('T-F3c-132 trocar o valor da marca falha', async () => {
    await emTransacao(async (c) => {
      const f = await novaFicha(c, { status: 'REGISTERED' });
      await aplicarMigration(c);
      await expect(
        c.query(`UPDATE workers SET phone_verification_waived_at = now() + interval '1 day' WHERE id = $1`, [f.id]),
      ).rejects.toThrow(/não pode ser removida nem trocada/);
    });
  });

  it("T-F3c-132 NULL -> valor só passa com SET LOCAL enlite.merge_in_progress = 'on'", async () => {
    await emTransacao(async (c) => {
      const f = await novaFicha(c, { status: 'INCOMPLETE_REGISTER' });
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE workers SET phone_verification_waived_at = now() WHERE id = $1`, [f.id])).rejects.toThrow(
        /só é escrita pelo merge/,
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query(`SET LOCAL enlite.merge_in_progress = 'on'`);
      await c.query(`UPDATE workers SET phone_verification_waived_at = now() WHERE id = $1`, [f.id]);
      expect(await waived(c, f.id)).not.toBeNull();
    });
  });

  // ── T-F3c-165 (AC-18 e AC-20) ──────────────────────────────────────────────────────────────────────────────
  /** Ficha com TODO o cadastro (menos a verificação do celular): é o que o dono da completude pede além do telefone. */
  async function fichaCompleta(c: PoolClient, status: string): Promise<string> {
    const w = await novaFicha(c, { status });
    await c.query(
      `UPDATE workers SET profession = 'CAREGIVER', first_name_encrypted = 'a', last_name_encrypted = 'b', sex_encrypted = 'c',
              gender_encrypted = 'd', birth_date_encrypted = 'e', document_number_encrypted = 'f', document_type = 'DNI',
              languages_encrypted = 'g', knowledge_level = 'BASIC', title_certificate = 'DEGREE', years_experience = '1-2',
              experience_types = ARRAY['TEA'], preferred_types = ARRAY['TEA'], preferred_age_range = ARRAY['CHILD']
        WHERE id = $1`,
      [w.id],
    );
    await c.query(`INSERT INTO worker_service_areas (worker_id, address_line, radius_km) VALUES ($1, 'Av. X 1', 5)`, [w.id]);
    await c.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1, 2, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
      [w.id],
    );
    await c.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url) VALUES ($1, 'http://e.com/id', 'http://e.com/cr')`,
      [w.id],
    );
    return w.id;
  }
  const mudarStatus = (c: PoolClient) => async (id: string, status: string) => {
    await c.query(`SELECT set_config('app.status_flow', 'TEST_FIXTURE', true)`);
    await c.query(`UPDATE workers SET status = $2 WHERE id = $1`, [id, status]);
  };

  it('T-F3c-165 o recálculo mantém a legada REGISTERED, sem linha nova no histórico (AC-18)', async () => {
    await emTransacao(async (c) => {
      const id = await fichaCompleta(c, 'REGISTERED'); // nasceu REGISTERED (importação): sem linha no histórico
      await aplicarMigration(c); // o corte: ganha a marca
      expect(await waived(c, id)).not.toBeNull();
      const hist = async () => Number((await c.query(`SELECT count(*) AS n FROM worker_status_history WHERE worker_id = $1`, [id])).rows[0].n);
      const antes = await hist();
      expect(await recalculateStatus(c as unknown as Pool, id, mudarStatus(c))).toBeNull();
      expect((await c.query(`SELECT status FROM workers WHERE id = $1`, [id])).rows[0].status).toBe('REGISTERED');
      expect(await hist()).toBe(antes);
    });
  });

  it('T-F3c-165 ficha nova sem verificação: o guard recusa REGISTERED com phone_unverified (AC-20)', async () => {
    await emTransacao(async (c) => {
      const id = await fichaCompleta(c, 'INCOMPLETE_REGISTER');
      await c.query('SAVEPOINT s');
      await expect(mudarStatus(c)(id, 'REGISTERED')).rejects.toThrow(/phone_unverified/);
      await c.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  it('T-F3c-165 a mesma ficha, depois de verificar, passa no guard', async () => {
    await emTransacao(async (c) => {
      const id = await fichaCompleta(c, 'INCOMPLETE_REGISTER');
      await gravarVerificacao(c, id);
      await mudarStatus(c)(id, 'REGISTERED');
      expect((await c.query(`SELECT status FROM workers WHERE id = $1`, [id])).rows[0].status).toBe('REGISTERED');
    });
  });
});
