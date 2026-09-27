/**
 * quick-response-team-precedence.e2e.test.ts
 *
 * Régua da precedência 8 de QUICK_RESPONSE_TEAM (migration 477, DX-4.2, Fase 4 —
 * cadeia-paciente-vacante-itinerario). Molde: ApplicationFunnelStageRepository.test.ts
 * (banco real, sem mock, helpers de INSERT em workers/job_postings/worker_job_applications).
 *
 * O que garante, e por quê:
 *   QRT1 — funnel_stage_precedence('QUICK_RESPONSE_TEAM') = 8, e > SELECTED/REJECTED (7).
 *          Sem isso, um webhook da Talentum que mapeia para SELECTED/REJECTED
 *          (TalentumFunnelStageMapper.ts:40,42) venceria o empate com >= e tiraria a
 *          pessoa da Equipe de Resposta Rápida em silêncio (comentário da migration 477).
 *   QRT2 — o CHECK de worker_job_applications.application_funnel_stage contém
 *          QUICK_RESPONSE_TEAM e NÃO contém RAPID_RESPONSE (os dois conceitos são
 *          distintos: RAPID_RESPONSE já é job_postings.status e encuadres.role —
 *          fase-4.md linhas 26-33).
 *   QRT3 — a condição literal do upsert automático da Talentum
 *          (TalentumPrescreeningRepository.ts:157-158: `WHEN funnel_stage_precedence(
 *          EXCLUDED.application_funnel_stage) >= funnel_stage_precedence(
 *          worker_job_applications.application_funnel_stage)`), aplicada por SQL a um
 *          card sintético em QUICK_RESPONSE_TEAM, NÃO sobrescreve para REJECTED nem
 *          para SELECTED (UPDATE 0 — precedência 7 não supera 8); o mesmo card em
 *          CONFIRMED (precedência 6) É sobrescrito por REJECTED (UPDATE 1 — controle
 *          positivo de que a guarda funciona quando deveria).
 *
 * Sabotagem que esta régua tem de detectar: trocar o `THEN 8` da migration 477 de
 * volta para `THEN 7` (empate com SELECTED/REJECTED) — QRT1 e QRT3 caem.
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const TEST_EMAIL_DOMAIN = '@qrtprecedence.test';

function makeSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function insertTestWorker(suffix: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO workers (auth_uid, email, country, timezone, status)
     VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED')
     RETURNING id`,
    [`uid-qrtprec-${suffix}`, `worker-qrtprec-${suffix}${TEST_EMAIL_DOMAIN}`],
  );
  return result.rows[0].id as string;
}

async function insertTestJobPosting(suffix: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO job_postings (title, description, country, status)
     VALUES ($1, 'Test job description (QRT precedence)', 'AR', 'ACTIVE')
     RETURNING id`,
    [`QRT precedence test ${suffix}`],
  );
  return result.rows[0].id as string;
}

/** source='talentum' para bypass do trigger enforce_worker_registered_for_application
 * (mig 183/196/229) — a fixture não precisa satisfazer essa invariante de negócio. */
async function insertApplication(
  workerId: string,
  jobPostingId: string,
  stage: string,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, $3, 'talentum')
     RETURNING id`,
    [workerId, jobPostingId, stage],
  );
  return result.rows[0].id as string;
}

async function getApplicationStage(applicationId: string): Promise<string> {
  const result = await pool.query(
    'SELECT application_funnel_stage FROM worker_job_applications WHERE id = $1',
    [applicationId],
  );
  return result.rows[0]?.application_funnel_stage as string;
}

afterAll(async () => {
  // Limpa apenas os dados inseridos neste arquivo de teste (defesa extra —
  // cada describe também limpa os próprios registros em afterEach).
  await pool.query(`DELETE FROM workers WHERE email LIKE '%${TEST_EMAIL_DOMAIN}'`);
  await pool.end();
});

// ── QRT1: precedência da função ────────────────────────────────────────────────

describe('QRT1 — funnel_stage_precedence: QUICK_RESPONSE_TEAM = 8, acima de SELECTED/REJECTED (7)', () => {
  it('QUICK_RESPONSE_TEAM=8, SELECTED=7, REJECTED=7, e 8 > 7 nos dois casos', async () => {
    const result = await pool.query(
      `SELECT funnel_stage_precedence('QUICK_RESPONSE_TEAM') AS qrt,
              funnel_stage_precedence('SELECTED') AS selected,
              funnel_stage_precedence('REJECTED') AS rejected`,
    );
    const { qrt, selected, rejected } = result.rows[0];

    expect(qrt).toBe(8);
    expect(selected).toBe(7);
    expect(rejected).toBe(7);
    expect(qrt).toBeGreaterThan(selected);
    expect(qrt).toBeGreaterThan(rejected);
  });
});

// ── QRT2: CHECK constraint ──────────────────────────────────────────────────────

describe('QRT2 — CHECK de application_funnel_stage lista QUICK_RESPONSE_TEAM e não RAPID_RESPONSE', () => {
  it('pg_get_constraintdef contém o literal QUICK_RESPONSE_TEAM e não contém RAPID_RESPONSE', async () => {
    const result = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'worker_job_applications'::regclass
         AND conname = 'worker_job_applications_application_funnel_stage_check'`,
    );

    expect(result.rows.length).toBe(1);
    const def = result.rows[0].def as string;
    expect(def).toContain('QUICK_RESPONSE_TEAM');
    expect(def).not.toContain('RAPID_RESPONSE');
  });
});

// ── QRT3: guarda do upsert automático da Talentum sobre um card em QUICK_RESPONSE_TEAM ──

describe('QRT3 — guarda do upsert da Talentum (precedence >=) sobre card em QUICK_RESPONSE_TEAM', () => {
  let workerId: string;
  let jobPostingId: string;
  let wjaId: string;

  beforeEach(async () => {
    const s = makeSuffix();
    workerId = await insertTestWorker(s);
    jobPostingId = await insertTestJobPosting(s);
    wjaId = await insertApplication(workerId, jobPostingId, 'QUICK_RESPONSE_TEAM');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM worker_job_applications WHERE id = $1', [wjaId]);
    await pool.query('DELETE FROM job_postings WHERE id = $1', [jobPostingId]);
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
  });

  it.each(['REJECTED', 'SELECTED'])(
    'card em QUICK_RESPONSE_TEAM + webhook mapeando para %s → UPDATE 0 (não sai da Equipe)',
    async (targetStage) => {
      // Mesma condição literal de TalentumPrescreeningRepository.ts:157-158 —
      // `EXCLUDED.application_funnel_stage` é o $2 (nova etapa que o webhook tentaria
      // aplicar); `worker_job_applications.application_funnel_stage` é a etapa atual da
      // própria linha (id = $1).
      const result = await pool.query(
        `UPDATE worker_job_applications
            SET application_funnel_stage = $2
          WHERE id = $1
            AND funnel_stage_precedence($2) >= funnel_stage_precedence(application_funnel_stage)`,
        [wjaId, targetStage],
      );

      expect(result.rowCount).toBe(0);
      await expect(getApplicationStage(wjaId)).resolves.toBe('QUICK_RESPONSE_TEAM');
    },
  );

  it('controle positivo: card em CONFIRMED (precedência 6) + REJECTED (7) → UPDATE 1 (guarda sobrescreve quando deveria)', async () => {
    await pool.query(
      `UPDATE worker_job_applications SET application_funnel_stage = 'CONFIRMED' WHERE id = $1`,
      [wjaId],
    );
    await expect(getApplicationStage(wjaId)).resolves.toBe('CONFIRMED');

    const result = await pool.query(
      `UPDATE worker_job_applications
          SET application_funnel_stage = $2
        WHERE id = $1
          AND funnel_stage_precedence($2) >= funnel_stage_precedence(application_funnel_stage)`,
      [wjaId, 'REJECTED'],
    );

    expect(result.rowCount).toBe(1);
    await expect(getApplicationStage(wjaId)).resolves.toBe('REJECTED');
  });
});
