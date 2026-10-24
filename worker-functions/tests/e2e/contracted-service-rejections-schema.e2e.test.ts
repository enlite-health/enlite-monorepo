/**
 * contracted-service-rejections-schema.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 10, P3
 *
 * Prova, contra Postgres real, as regras escritas na migration 481 (DX-10.2, DX-10.14):
 *   - `reject_reason_category` NOT NULL / FK para o catálogo `service_exit_reasons(code)` (csr_reject_reason_fk,
 *     migration 493 — antes era o CHECK de 4 códigos, csr_reject_reason_check, da 481).
 *   - reversão: `reverted_at` exige `revert_reason_category` (csr_revert_has_reason), motivo de
 *     reversão de lista fechada (csr_revert_reason_check), `reverted_at` exige `reverted_by`
 *     (csr_revert_has_actor).
 *   - `uq_csr_active_pair`: um prestador não fica rejeitado 2x ao mesmo tempo no mesmo serviço;
 *     reverter libera o par para marca nova (linha nova, nunca reescrita — a tabela é o log).
 *   - `country` herdado do serviço pelo trigger.
 *   - GRANT/REVOKE: `app_runtime` sem DELETE, com INSERT/UPDATE/SELECT.
 *   - a purga do paciente (D248) leva a marca em cascata (ON DELETE CASCADE via o serviço).
 *   - critério 17 (sem texto livre): as únicas colunas de texto são as da migration.
 *
 * Semente por SQL no beforeAll, como dono (nunca pela API): 2 pacientes AR, 1 serviço cada
 * (molde `patient-itinerary-schema.e2e.test.ts`), 2 workers. Nenhuma vaga / WJA — a marca do
 * quadro C não referencia `job_postings` nem `worker_job_applications` (invariante 6).
 *
 * Pares (service, worker) usados abaixo: os testes 1-5 provam CHECKs que recusam o INSERT — nenhum
 * deles grava linha, então o par fica livre para o próximo teste que precisar dele (mesma régua do
 * comentário em `patient-itinerary-schema.e2e.test.ts:258-260`: só um INSERT ACEITO deixaria o par
 * ocupado para `uq_csr_active_pair`).
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `csr-e2e-${RUN}-`;

interface PgErrorLike {
  code?: string;
  constraint?: string;
  column?: string;
  message: string;
}

async function expectPgError(query: Promise<unknown>): Promise<PgErrorLike> {
  let caught: PgErrorLike | null = null;
  try {
    await query;
  } catch (e) {
    caught = e as PgErrorLike;
  }
  if (!caught) {
    throw new Error('esperava erro do Postgres, mas o INSERT foi aceito');
  }
  return caught;
}

describe('contracted_service_rejections — regras do banco (migration 481) @integration', () => {
  let pool: Pool;

  let patient1 = '';
  let patient2 = '';
  let service1 = '';
  let service2 = '';
  let worker1 = '';
  let worker2 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    patient1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Rejeicao', 'Uno', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p1`],
      )
    ).rows[0].id;
    patient2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Rejeicao', 'Dos', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p2`],
      )
    ).rows[0].id;

    const address1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient1],
      )
    ).rows[0].id;
    const address2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient2],
      )
    ).rows[0].id;

    service1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patient1, address1, TASK_PREFIX],
      )
    ).rows[0].id;
    service2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patient2, address2, TASK_PREFIX],
      )
    ).rows[0].id;

    worker1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}w1`, `${TASK_PREFIX}w1@e2e.local`],
      )
    ).rows[0].id;
    worker2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}w2`, `${TASK_PREFIX}w2@e2e.local`],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    // Ordem: marcas → workers → pacientes (o de patient2/service2 já saiu em cascata no teste (j)).
    await pool.query(`DELETE FROM contracted_service_rejections WHERE rejected_by = $1`, [TASK_PREFIX]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [[worker1, worker2]]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);

    const leftover = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contracted_service_rejections WHERE rejected_by = $1`,
      [TASK_PREFIX],
    );
    expect(leftover.rows[0].n).toBe(0);

    await pool.end();
  });

  // ── (a) reject_reason_category ─────────────────────────────────────────────

  it('(a) reject_reason_category NULL → 23502', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, NULL, $3, $3)`,
        [service1, worker1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23502');
    expect(err.column).toBe('reject_reason_category');
  });

  it('(b) reject_reason_category com código inexistente no catálogo → 23503 csr_reject_reason_fk (era o CHECK da 481)', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, 'MOTIVO_INEXISTENTE', $3, $3)`,
        [service1, worker2, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('csr_reject_reason_fk');
  });

  it('(b2) só a FK ficou: o CHECK antigo de rejeitar saiu, o de reverter FICA', async () => {
    const r = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'contracted_service_rejections'::regclass AND conname IN ('csr_reject_reason_check', 'csr_reject_reason_fk', 'csr_revert_reason_check')
        ORDER BY conname`,
    );
    expect(r.rows.map((row) => row.conname)).toEqual(['csr_reject_reason_fk', 'csr_revert_reason_check']);
  });

  it('(b3) código criado pelo admin no catálogo (não é um dos 4 antigos) é aceito pela FK', async () => {
    const code = `${TASK_PREFIX}motivo`;
    await pool.query(
      `INSERT INTO service_exit_reasons (code, label) VALUES ($1, $2)`,
      [code, `${TASK_PREFIX}Cambio de disponibilidad`],
    );
    try {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $3, $3) RETURNING id`,
        [service1, worker2, TASK_PREFIX, code],
      );
      expect(ins.rows[0].id).toBeTruthy();
      // desativar o item NÃO apaga nem invalida a marca (a FK só confere existência)
      await pool.query(`UPDATE service_exit_reasons SET active = false, deactivated_at = now() WHERE code = $1`, [code]);
      const still = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM contracted_service_rejections WHERE id = $1`, [ins.rows[0].id]);
      expect(still.rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM contracted_service_rejections WHERE rejected_by = $1 AND reject_reason_category = $2`, [TASK_PREFIX, code]);
      await pool.query(`DELETE FROM service_exit_reasons WHERE code = $1`, [code]);
    }
  });

  // ── (c)-(e) reversão ────────────────────────────────────────────────────────

  it('(c) reverted_at sem revert_reason_category → 23514 csr_revert_has_reason', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO contracted_service_rejections
           (service_id, worker_id, rejected_by, reject_reason_category, reverted_at, reverted_by, revert_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, 'OTHER', now(), $3, NULL, $3, $3)`,
        [service2, worker1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('csr_revert_has_reason');
  });

  it('(d) revert_reason_category fora da lista → 23514 csr_revert_reason_check', async () => {
    const err = await expectPgError(
      pool.query(
        `INSERT INTO contracted_service_rejections
           (service_id, worker_id, rejected_by, reject_reason_category, reverted_at, reverted_by, revert_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, 'OTHER', now(), $3, 'MOTIVO_INEXISTENTE', $3, $3)`,
        [service2, worker2, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('csr_revert_reason_check');
  });

  it('(e) reverted_at sem reverted_by → 23514 csr_revert_has_actor', async () => {
    // Reusa (service1, worker1): o teste (a) recusou o INSERT (23502) e não gravou linha — o par
    // segue livre (não faça: reusar par com marca ATIVA, o que não é o caso aqui).
    const err = await expectPgError(
      pool.query(
        `INSERT INTO contracted_service_rejections
           (service_id, worker_id, rejected_by, reject_reason_category, reverted_at, reverted_by, revert_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, 'OTHER', now(), NULL, 'REAVALIACAO', $3, $3)`,
        [service1, worker1, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('csr_revert_has_actor');
  });

  // ── (f)-(g) uq_csr_active_pair ───────────────────────────────────────────────

  let activeMarkId = '';

  it('(f) 1ª marca do par (service1, worker2) → aceita; 2ª marca ativa do mesmo par → 23505 uq_csr_active_pair', async () => {
    const first = await pool.query<{ id: string }>(
      `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
       VALUES ($1, $2, $3, 'PERFIL_INADEQUADO_AO_SERVICO', $3, $3) RETURNING id`,
      [service1, worker2, TASK_PREFIX],
    );
    activeMarkId = first.rows[0].id;
    expect(activeMarkId).toBeTruthy();

    const err = await expectPgError(
      pool.query(
        `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, 'INDISPONIBILIDADE_DE_HORARIO', $3, $3)`,
        [service1, worker2, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('uq_csr_active_pair');
  });

  it('(g) marca nova do mesmo par depois de reverter a 1ª → aceita (a tabela é o log)', async () => {
    await pool.query(
      `UPDATE contracted_service_rejections SET reverted_at = now(), reverted_by = $2, revert_reason_category = 'REAVALIACAO'
       WHERE id = $1`,
      [activeMarkId, TASK_PREFIX],
    );

    const second = await pool.query<{ id: string }>(
      `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
       VALUES ($1, $2, $3, 'DESISTENCIA_DO_PRESTADOR', $3, $3) RETURNING id`,
      [service1, worker2, TASK_PREFIX],
    );
    expect(second.rows[0].id).toBeTruthy();
    expect(second.rows[0].id).not.toBe(activeMarkId);
  });

  // ── (h) country ───────────────────────────────────────────────────────────────

  it('(h) country herdado do serviço pelo trigger', async () => {
    const r = await pool.query<{ country: string }>(
      `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
       VALUES ($1, $2, $3, 'OTHER', $3, $3) RETURNING country`,
      [service2, worker2, TASK_PREFIX],
    );
    expect(r.rows[0].country).toBe('AR');
  });

  // ── (i) grants ──────────────────────────────────────────────────────────────

  it('(i) app_runtime sem DELETE, com INSERT/UPDATE/SELECT', async () => {
    const r = await pool.query<{
      del: boolean;
      ins: boolean;
      upd: boolean;
      sel: boolean;
    }>(
      `SELECT
         has_table_privilege('app_runtime', 'contracted_service_rejections', 'DELETE') AS del,
         has_table_privilege('app_runtime', 'contracted_service_rejections', 'INSERT') AS ins,
         has_table_privilege('app_runtime', 'contracted_service_rejections', 'UPDATE') AS upd,
         has_table_privilege('app_runtime', 'contracted_service_rejections', 'SELECT') AS sel`,
    );
    const row = r.rows[0];
    expect(row.del).toBe(false);
    expect(row.ins).toBe(true);
    expect(row.upd).toBe(true);
    expect(row.sel).toBe(true);
  });

  // ── (j) purga do paciente (D248) ───────────────────────────────────────────────

  it('(j) DELETE FROM patients do paciente 2 leva a marca em cascata (count 0)', async () => {
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contracted_service_rejections WHERE service_id = $1`,
      [service2],
    );
    expect(before.rows[0].n).toBe(1);

    await pool.query(`DELETE FROM patients WHERE id = $1`, [patient2]);

    const afterService = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_contracted_services WHERE id = $1`,
      [service2],
    );
    expect(afterService.rows[0].n).toBe(0);

    const afterMark = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contracted_service_rejections WHERE service_id = $1`,
      [service2],
    );
    expect(afterMark.rows[0].n).toBe(0);
  });

  // ── (k) critério 17 — sem texto livre ────────────────────────────────────────

  it('(k) colunas de texto são exatamente as da migration (critério 17, sem observação livre)', async () => {
    const r = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'contracted_service_rejections' AND data_type IN ('text', 'character varying')
       ORDER BY column_name`,
    );
    expect(r.rows.map((row) => row.column_name)).toEqual([
      'country',
      'created_by',
      'reject_reason_category',
      'rejected_by',
      'revert_reason_category',
      'reverted_by',
      'updated_by',
    ]);
  });
});
