/**
 * ApplicationFunnelStageRepository.test.ts
 *
 * Testes unitários com banco real para validar a refatoração de
 * worker_job_applications.application_funnel_stage (Migration 096).
 *
 * Cada teste insere dados reais no banco de teste e valida o que foi persistido.
 *
 * Cenários cobertos:
 *   AF1  - INSERT com application_funnel_stage = 'INITIATED'
 *   AF2  - UPDATE para cada um dos 7 stages válidos
 *   AF3  - Constraint violation — stage antigo 'APPLIED' deve ser rejeitado
 *   AF4  - Constraint violation — stage antigo 'PRE_SCREENING' deve ser rejeitado
 *   AF5  - Constraint violation — stage antigo 'INTERVIEW_SCHEDULED' deve ser rejeitado
 *   AF6  - Constraint violation — stage antigo 'INTERVIEWED' deve ser rejeitado
 *   AF7  - Constraint violation — stage antigo 'HIRED' deve ser rejeitado
 *   AF8  - Constraint violation — stage antigo 'REJECTED' deve ser rejeitado
 *   AF9  - Listar applications por stage — filtrar 1 de 3 em stages distintos
 *   AF10 - DEFAULT do stage ao INSERT sem especificar (verifica valor inicial)
 */

import { Pool } from 'pg';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

const TEST_EMAIL_DOMAIN = '@appfunnelstagerepo.test';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function insertTestWorker(suffix: string): Promise<string> {
  // status='REGISTERED' é obrigatório: trigger enforce_worker_registered_for_application
  // (migration 183) bloqueia INSERT em worker_job_applications se status != 'REGISTERED'.
  const result = await pool.query(
    `INSERT INTO workers (auth_uid, email, country, timezone, status)
     VALUES ($1, $2, 'BR', 'America/Sao_Paulo', 'REGISTERED')
     RETURNING id`,
    [`uid-${suffix}`, `worker-${suffix}${TEST_EMAIL_DOMAIN}`],
  );
  return result.rows[0].id as string;
}

async function insertTestJobPosting(suffix: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO job_postings (title, description, country, status)
     VALUES ($1, 'Test job description', 'BR', 'ACTIVE')
     RETURNING id`,
    [`Test Job ${suffix}`],
  );
  return result.rows[0].id as string;
}

/** Insere application com stage explícito. Omitir stage usa 'INVITED' como fallback seguro.
 * Usa source='talentum' para bypass do trigger enforce_worker_registered_for_application
 * (migration 183) — o trigger só valida status='REGISTERED' para sources não confiáveis.
 * Fixtures de teste não precisam satisfazer essa invariante de negócio.
 */
async function insertApplication(
  workerId: string,
  jobPostingId: string,
  stage?: string,
): Promise<string> {
  const resolvedStage = stage ?? 'INVITED';
  const result = await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, $3, 'talentum')
     RETURNING id`,
    [workerId, jobPostingId, resolvedStage],
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

function makeSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Limpa apenas os dados inseridos neste arquivo de teste
afterEach(async () => {
  await pool.query(
    `DELETE FROM workers WHERE email LIKE '%${TEST_EMAIL_DOMAIN}'`,
  );
});

afterAll(async () => {
  await pool.end();
});

// ── AF1: INSERT com INITIATED ─────────────────────────────────────────────────

describe('AF1 — INSERT com application_funnel_stage = INITIATED', () => {
  it('deve persistir stage = INITIATED corretamente', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act
    const appId = await insertApplication(workerId, jobId, 'INITIATED');

    // Assert
    const stage = await getApplicationStage(appId);
    expect(stage).toBe('INITIATED');
  });
});

// ── AF2: UPDATE para cada um dos 7 stages válidos ─────────────────────────────

describe('AF2 — UPDATE para cada um dos stages válidos', () => {
  // Stages válidos pós-migration 230: PRE_SCREENING adicionado (renomeação canônica de INITIATED).
  // INITIATED permanece no CHECK (fase-1 rolling deploy) mas deriveFunnelStage nunca o grava.
  // Stages atuais: INVITED, INITIATED, PRE_SCREENING, IN_PROGRESS, COMPLETED, QUALIFIED,
  //                IN_DOUBT, CONFIRMED, SELECTED, REJECTED
  const VALID_STAGES = [
    'INITIATED',
    'PRE_SCREENING',
    'IN_PROGRESS',
    'COMPLETED',
    'QUALIFIED',
    'IN_DOUBT',
    'CONFIRMED',
    'SELECTED',
    'REJECTED',
  ] as const;

  it.each(VALID_STAGES)(
    'deve aceitar UPDATE para stage = %s e persistir no banco',
    async (targetStage) => {
      // Arrange
      const s = makeSuffix();
      const workerId = await insertTestWorker(s);
      const jobId = await insertTestJobPosting(s);
      const appId = await insertApplication(workerId, jobId, 'INITIATED');

      // Act
      await pool.query(
        'UPDATE worker_job_applications SET application_funnel_stage = $1 WHERE id = $2',
        [targetStage, appId],
      );

      // Assert
      const stage = await getApplicationStage(appId);
      expect(stage).toBe(targetStage);
    },
  );
});

// ── AF3–AF8: Constraint — stages antigos devem ser rejeitados ─────────────────

describe('AF3 — Constraint violation: stage antigo APPLIED', () => {
  it('deve rejeitar INSERT com stage = "APPLIED"', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act / Assert
    await expect(insertApplication(workerId, jobId, 'APPLIED')).rejects.toThrow();
  });
});

describe('AF4 — PRE_SCREENING é stage válido (migration 230 adicionou ao CHECK)', () => {
  it('deve aceitar INSERT com stage = "PRE_SCREENING" (canônico interno de INITIATED, adicionado em migration 230)', async () => {
    // PRE_SCREENING era inválido antes da migration 230. Após a migration, é o stage canônico
    // que substituiu INITIATED internamente (deriveFunnelStage converte subtype='INITIATED' → 'PRE_SCREENING').
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act / Assert — deve inserir sem erros
    await expect(insertApplication(workerId, jobId, 'PRE_SCREENING')).resolves.toBeTruthy();
  });

  it('deve rejeitar INSERT com stage inválido PLACED (removido em migration 191)', async () => {
    // PLACED foi removido do CHECK constraint em migration 191. Continua inválido.
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    await expect(insertApplication(workerId, jobId, 'PLACED')).rejects.toThrow();
  });
});

describe('AF5 — Constraint violation: stage antigo INTERVIEW_SCHEDULED', () => {
  it('deve rejeitar INSERT com stage = "INTERVIEW_SCHEDULED"', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act / Assert
    await expect(insertApplication(workerId, jobId, 'INTERVIEW_SCHEDULED')).rejects.toThrow();
  });
});

describe('AF6 — Constraint violation: stage antigo INTERVIEWED', () => {
  it('deve rejeitar INSERT com stage = "INTERVIEWED"', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act / Assert
    await expect(insertApplication(workerId, jobId, 'INTERVIEWED')).rejects.toThrow();
  });
});

describe('AF7 — Constraint violation: stage antigo HIRED', () => {
  it('deve rejeitar INSERT com stage = "HIRED"', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act / Assert
    await expect(insertApplication(workerId, jobId, 'HIRED')).rejects.toThrow();
  });
});

describe('AF8 — REJECTED é um stage válido (migration 123 adicionou ao CHECK)', () => {
  it('deve aceitar INSERT com stage = "REJECTED" (adicionado em migration 123)', async () => {
    // REJECTED foi adicionado ao CHECK constraint em migration 123_reminder_reschedule_flow.sql
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Deve inserir sem erros
    await expect(insertApplication(workerId, jobId, 'REJECTED')).resolves.toBeTruthy();
  });

  it('deve aceitar UPDATE para stage = "REJECTED" em application existente', async () => {
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);
    const appId = await insertApplication(workerId, jobId, 'INITIATED');

    // Deve atualizar sem erros
    await expect(
      pool.query(
        'UPDATE worker_job_applications SET application_funnel_stage = $1 WHERE id = $2',
        ['REJECTED', appId],
      ),
    ).resolves.toBeDefined();
  });
});

// ── AF9: Listar applications por stage ────────────────────────────────────────

describe('AF9 — Listar applications por stage', () => {
  it('deve retornar apenas 1 application ao filtrar por QUALIFIED entre 3 em stages distintos', async () => {
    // Arrange — 1 worker, 3 vagas, 3 stages diferentes
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);

    const jobId1 = await insertTestJobPosting(`${s}-job1`);
    const jobId2 = await insertTestJobPosting(`${s}-job2`);
    const jobId3 = await insertTestJobPosting(`${s}-job3`);

    await insertApplication(workerId, jobId1, 'INITIATED');
    await insertApplication(workerId, jobId2, 'QUALIFIED');
    // NOT_QUALIFIED foi removido do CHECK pós-migration 191/194; usar IN_DOUBT (válido)
    await insertApplication(workerId, jobId3, 'IN_DOUBT');

    // Act — busca apenas stage = QUALIFIED para este worker
    const result = await pool.query(
      `SELECT id FROM worker_job_applications
       WHERE worker_id = $1 AND application_funnel_stage = 'QUALIFIED'`,
      [workerId],
    );

    // Assert
    expect(result.rows.length).toBe(1);
  });

  it('deve retornar 0 applications ao filtrar por stage sem nenhum match', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);
    await insertApplication(workerId, jobId, 'INITIATED');

    // Act
    const result = await pool.query(
      `SELECT id FROM worker_job_applications
       WHERE worker_id = $1 AND application_funnel_stage = 'PLACED'`,
      [workerId],
    );

    // Assert
    expect(result.rows.length).toBe(0);
  });

  it('deve retornar todas as 3 applications ao filtrar sem restrição de stage', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);

    const jobId1 = await insertTestJobPosting(`${s}-a`);
    const jobId2 = await insertTestJobPosting(`${s}-b`);
    const jobId3 = await insertTestJobPosting(`${s}-c`);

    await insertApplication(workerId, jobId1, 'IN_PROGRESS');
    await insertApplication(workerId, jobId2, 'COMPLETED');
    await insertApplication(workerId, jobId3, 'IN_DOUBT');

    // Act
    const result = await pool.query(
      'SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = $1 ORDER BY applied_at',
      [workerId],
    );

    // Assert
    expect(result.rows.length).toBe(3);
    const stages = result.rows.map((r) => r.application_funnel_stage as string);
    expect(stages).toContain('IN_PROGRESS');
    expect(stages).toContain('COMPLETED');
    expect(stages).toContain('IN_DOUBT');
  });
});

// ── AF10: Sem DEFAULT — INSERT sem stage deve falhar (migration 187) ────────────

describe('AF10 — INSERT sem application_funnel_stage falha com NOT NULL (migration 187)', () => {
  it('INSERT sem application_funnel_stage deve falhar com violação de NOT NULL', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act / Assert — migration 187 removeu o DEFAULT e forçou NOT NULL.
    // Usa source='planilla_operativa' para bypasser o trigger enforce_worker_registered
    // (migration 183) e isolar o teste de NOT NULL constraint (código 23502).
    await expect(
      pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, source)
         VALUES ($1, $2, 'planilla_operativa') RETURNING id`,
        [workerId, jobId],
      ),
    ).rejects.toMatchObject({ code: '23502' }); // 23502 = not_null_violation
  });

  it('INSERT com stage explícito INVITED deve ter sucesso', async () => {
    // Arrange
    const s = makeSuffix();
    const workerId = await insertTestWorker(s);
    const jobId = await insertTestJobPosting(s);

    // Act — INSERT com stage explícito (obrigatório após migration 187)
    const appId = await insertApplication(workerId, jobId, 'INVITED');

    // Assert
    const stage = await getApplicationStage(appId);
    expect(stage).toBe('INVITED');
  });
});
