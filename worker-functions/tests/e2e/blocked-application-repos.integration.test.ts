/**
 * blocked-application-repos.integration.test.ts
 *
 * Testes de integração com banco REAL para:
 *   - BlockedApplicationRepository.upsert (write side)
 *   - BlockedApplicationQueryRepository.list + aggregates (read side)
 *
 * Não usa API — acessa pool diretamente.
 * INVARIANTE: migration 209 deve estar aplicada.
 *
 * Branches SQL de fn_worker_missing_fields ficam em:
 *   tests/e2e/fn-worker-missing-fields.integration.test.ts
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALL_WORKER_IDS: string[] = [];
let PATIENT_ID: string;
let VACANCY_ID: string;

// ── Helpers ────────────────────────────────────────────────────────────

async function makeWorker(
  status: 'INCOMPLETE_REGISTER' | 'DISABLED' | 'REGISTERED',
  tag: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-repos-${SUFFIX}-${tag}`, `repos-${SUFFIX}-${tag}@blocked.test`, status],
  );
  ALL_WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

// ── Global setup/teardown ──────────────────────────────────────────────

beforeAll(async () => {
  const { rows: pRows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'E2E', 'ReposBlocked', 'AR', 'ACTIVE') RETURNING id`,
    [`e2e-repos-${SUFFIX}`],
  );
  PATIENT_ID = pRows[0].id;

  const { rows: vRows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, patient_id, case_number)
     VALUES ('Vaga Repos Blocked', 'AR', 'SEARCHING', $1, 99993) RETURNING id`,
    [PATIENT_ID],
  );
  VACANCY_ID = vRows[0].id;
});

afterAll(async () => {
  if (ALL_WORKER_IDS.length) {
    await pool.query(
      `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
      [ALL_WORKER_IDS],
    );
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
  }
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [VACANCY_ID]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  await pool.end();
});

// ── 1. BlockedApplicationRepository.upsert ────────────────────────────

describe('BlockedApplicationRepository (banco real)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockedApplicationRepository } = require('../../src/modules/matching/infrastructure/BlockedApplicationRepository') as typeof import('../../src/modules/matching/infrastructure/BlockedApplicationRepository');

  const upsertWorkerIds: string[] = [];

  afterEach(async () => {
    if (upsertWorkerIds.length) {
      await pool.query(
        `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
        [upsertWorkerIds],
      );
      upsertWorkerIds.length = 0;
    }
  });

  it('primeira tentativa cria linha com attempt_count=1', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'upsert-1');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: 'facebook' });

    const { rows } = await pool.query(
      `SELECT attempt_count, blocked_reason_at_attempt, acquisition_channel, missing_fields_at_attempt
       FROM worker_blocked_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, VACANCY_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_count).toBe(1);
    expect(rows[0].blocked_reason_at_attempt).toBe('registration_incomplete');
    expect(rows[0].acquisition_channel).toBe('facebook');
    expect(Array.isArray(rows[0].missing_fields_at_attempt)).toBe(true);
  });

  it('segunda tentativa incrementa attempt_count SEM duplicar linha', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'upsert-2');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: 'site' });
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: 'linkedin' });

    const { rows } = await pool.query(
      `SELECT attempt_count, acquisition_channel, first_attempted_at, last_attempted_at
       FROM worker_blocked_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, VACANCY_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_count).toBe(2);
    expect(rows[0].acquisition_channel).toBe('site'); // first-value-wins
    expect((rows[0].last_attempted_at as Date).getTime()).toBeGreaterThanOrEqual(
      (rows[0].first_attempted_at as Date).getTime(),
    );
  });

  it('acquisition_channel first-value-wins (COALESCE)', async () => {
    const workerId = await makeWorker('DISABLED', 'upsert-coalesce');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'worker_disabled', acquisitionChannel: 'whatsapp' });
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'worker_disabled', acquisitionChannel: 'instagram' });

    const { rows } = await pool.query(`SELECT acquisition_channel FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
    expect(rows[0].acquisition_channel).toBe('whatsapp');
  });

  it('reason=worker_disabled → missing_fields_at_attempt=[]', async () => {
    const workerId = await makeWorker('DISABLED', 'upsert-disabled');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'worker_disabled', acquisitionChannel: null });

    const { rows } = await pool.query(`SELECT missing_fields_at_attempt, blocked_reason_at_attempt FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
    expect(rows[0].missing_fields_at_attempt).toEqual([]);
    expect(rows[0].blocked_reason_at_attempt).toBe('worker_disabled');
  });

  it('reason=worker_not_found → missing_fields_at_attempt contém "worker_not_found"', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000003';
    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId: nonExistentId, jobPostingId: VACANCY_ID, reason: 'worker_not_found', acquisitionChannel: 'site' });

    const { rows } = await pool.query(`SELECT missing_fields_at_attempt FROM worker_blocked_applications WHERE worker_id = $1`, [nonExistentId]);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = $1`, [nonExistentId]);

    expect(rows).toHaveLength(1);
    expect(rows[0].missing_fields_at_attempt).toContain('worker_not_found');
  });

  it('missing_fields_at_attempt preenchido para worker incompleto', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'upsert-missing');
    upsertWorkerIds.push(workerId);

    const repo = new BlockedApplicationRepository();
    await repo.upsert({ workerId, jobPostingId: VACANCY_ID, reason: 'registration_incomplete', acquisitionChannel: null });

    const { rows } = await pool.query(`SELECT missing_fields_at_attempt FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
    expect(rows[0].missing_fields_at_attempt.length).toBeGreaterThan(0);
  });
});

// ── 2. BlockedApplicationQueryRepository.list/aggregates ─────────────

describe('BlockedApplicationQueryRepository (banco real)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockedApplicationQueryRepository } = require('../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository') as typeof import('../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository');

  const qWorkerIds: string[] = [];
  let qVacancyId: string;
  let qPatientId: string;
  let qWorkerInc: string;
  let qWorkerDis: string;

  beforeAll(async () => {
    const { rows: pRows } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'E2E', 'QueryBlocked2', 'AR', 'ACTIVE') RETURNING id`,
      [`e2e-qblk2-${SUFFIX}`],
    );
    qPatientId = pRows[0].id;

    const { rows: vRows } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Vaga Query Blocked 2', 'AR', 'SEARCHING', $1, 99994) RETURNING id`,
      [qPatientId],
    );
    qVacancyId = vRows[0].id;

    qWorkerInc = await makeWorker('INCOMPLETE_REGISTER', 'query-inc');
    qWorkerDis = await makeWorker('DISABLED', 'query-dis');
    qWorkerIds.push(qWorkerInc, qWorkerDis);

    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at)
       VALUES
         ($1, $2, 'registration_incomplete', '["phone"]', 'facebook', 2, NOW()-interval '2m', NOW()-interval '1m'),
         ($3, $2, 'worker_disabled', '[]', 'instagram', 1, NOW(), NOW())`,
      [qWorkerInc, qVacancyId, qWorkerDis],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[]) OR job_posting_id = $2`,
      [qWorkerIds, qVacancyId],
    );
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [qVacancyId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [qPatientId]);
  });

  it('filtra por jobPostingId — total=2, todos com qVacancyId', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 100, offset: 0 });
    expect(result.total).toBe(2);
    for (const item of result.data) expect(item.jobPostingId).toBe(qVacancyId);
  });

  it('filtra por workerId', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ workerId: qWorkerInc, limit: 100, offset: 0 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    for (const item of result.data) expect(item.workerId).toBe(qWorkerInc);
  });

  it('filtra por reason=registration_incomplete', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ reason: 'registration_incomplete', limit: 100, offset: 0 });
    for (const item of result.data) expect(item.blockedReason).toBe('registration_incomplete');
  });

  it('filtra por reason=worker_disabled', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ reason: 'worker_disabled', limit: 100, offset: 0 });
    for (const item of result.data) expect(item.blockedReason).toBe('worker_disabled');
  });

  it('paginação: limit=1 retorna 1 item, total=2', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 1, offset: 0 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it('paginação: offset=2 retorna data=[], total=2', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 10, offset: 2 });
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(2);
  });

  it('ordenação por last_attempted_at DESC', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, limit: 100, offset: 0 });
    if (result.data.length >= 2) {
      const first = new Date(result.data[0].lastAttemptedAt).getTime();
      const second = new Date(result.data[1].lastAttemptedAt).getTime();
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });

  it('DTO com todos os campos mapeados', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ workerId: qWorkerInc, limit: 1, offset: 0 });
    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(typeof item.id).toBe('string');
    expect(item.workerId).toBe(qWorkerInc);
    expect(item.jobPostingId).toBe(qVacancyId);
    expect(item.blockedReason).toBe('registration_incomplete');
    expect(Array.isArray(item.missingFields)).toBe(true);
    expect(item.attemptCount).toBe(2);
    expect(typeof item.firstAttemptedAt).toBe('string');
    expect(typeof item.lastAttemptedAt).toBe('string');
    expect(item.acquisitionChannel).toBe('facebook');
  });

  it('filtros combinados: jobPostingId + workerId → total=1', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const result = await repo.list({ jobPostingId: qVacancyId, workerId: qWorkerInc, limit: 10, offset: 0 });
    expect(result.total).toBe(1);
  });

  it('aggregates: totalBlocked === soma de byReason', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const agg = await repo.aggregates();
    const sum = Object.values(agg.byReason).reduce((acc, v) => acc + v, 0);
    expect(agg.totalBlocked).toBe(sum);
    expect(agg.byReason).toMatchObject({ registration_incomplete: expect.any(Number) });
  });

  // ── Regressão: listByVacancy recomputa missing_fields_at_attempt ON-READ ─────────
  // Bug: editar o perfil do worker (grava first_name/last_name) atualizava o
  // nome do card mas NÃO as tags de campos faltantes, pois vinham do snapshot
  // materializado. Fix: recompute via fn_worker_missing_fields p/ registration_incomplete.

  it('listByVacancy — recomputa ao vivo: preencher nome remove tags first_name/last_name do snapshot obsoleto', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'stale-recompute');
    qWorkerIds.push(workerId);

    // Snapshot OBSOLETO gravado quando o worker ainda não tinha nome.
    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at)
       VALUES ($1, $2, 'registration_incomplete',
               '["first_name","last_name","sex"]', 'portal', 1, NOW(), NOW())`,
      [workerId, qVacancyId],
    );

    // Operador edita o perfil → nome é persistido (colunas encriptadas ≠ vazio).
    await pool.query(
      `UPDATE workers
          SET first_name_encrypted = 'enc-nombre',
              last_name_encrypted  = 'enc-apellido'
        WHERE id = $1`,
      [workerId],
    );

    const result = await repo.listByVacancy(qVacancyId);
    const card = result.find(r => r.workerId === workerId);
    expect(card).toBeDefined();
    // Live recompute: nome preenchido → tags somem, mas sex continua faltando.
    expect(card!.missingFields).not.toContain('first_name');
    expect(card!.missingFields).not.toContain('last_name');
    expect(card!.missingFields).toContain('sex');
  });

  it('listByVacancy — worker_disabled IGNORA o snapshot: não existe "campo faltante" de quem está desativado', async () => {
    // Este teste media o comportamento ANTIGO ("MANTÉM snapshot"), que era metade
    // do defeito da D300: o motivo e os campos ficavam congelados no instante da
    // barrada e nunca mais atualizavam. A sentinela continua sendo o instrumento
    // certo — só que agora prova o CONTRÁRIO: que o snapshot é ignorado.
    const repo = new BlockedApplicationQueryRepository();
    const workerId = await makeWorker('DISABLED', 'stale-ignora-snapshot');
    qWorkerIds.push(workerId);

    // Sentinela que a função NUNCA produziria — se aparecer, o snapshot vazou.
    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at)
       VALUES ($1, $2, 'worker_disabled', '["__sentinel_snapshot__"]', 'portal', 1, NOW(), NOW())`,
      [workerId, qVacancyId],
    );

    const result = await repo.listByVacancy(qVacancyId);
    const card = result.find(r => r.workerId === workerId);
    expect(card).toBeDefined();
    expect(card!.missingFields).not.toContain('__sentinel_snapshot__');
    expect(card!.missingFields).toEqual([]);
    // E o motivo é recalculado contra o estado de hoje, não lido da coluna.
    expect(card!.blockedReason).toBe('worker_disabled');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Aba de encuadre do worker-detail: engajamentos por WORKER = WJA ∪ blocked.
// Prova que a ficha do prestador mostra a REALIDADE (todas as vagas) com o status
// = coluna do Kanban (deriveKanbanColumn), e que blocked promovido a WJA some daqui.
// ─────────────────────────────────────────────────────────────────────────
describe('Worker engagements por worker (banco real)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WorkerApplicationRepository } = require('../../src/modules/matching/infrastructure/WorkerApplicationRepository') as typeof import('../../src/modules/matching/infrastructure/WorkerApplicationRepository');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockedApplicationQueryRepository } = require('../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository') as typeof import('../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository');

  let engWorker: string;
  let engPatientId: string;
  let vPre: string;   // vaga com WJA PRE_SCREENING
  let vManual: string; // vaga com WJA INVITED+manual → INICIADO
  let vBlocked: string; // vaga só bloqueada

  beforeAll(async () => {
    const { rows: pRows } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'E2E', 'EngWorker', 'AR', 'ACTIVE') RETURNING id`,
      [`e2e-eng-${SUFFIX}`],
    );
    engPatientId = pRows[0].id;

    const mkVacancy = async (caseNumber: number): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, country, status, patient_id, case_number)
         VALUES ('Vaga Eng', 'AR', 'SEARCHING', $1, $2) RETURNING id`,
        [engPatientId, caseNumber],
      );
      return rows[0].id;
    };
    vPre = await mkVacancy(88881);
    vManual = await mkVacancy(88882);
    vBlocked = await mkVacancy(88883);

    // REGISTERED para o guard (mig 183) aceitar as WJA — 'manual' não tem bypass de source.
    engWorker = await makeWorker('REGISTERED', 'eng');

    // WJA: PRE_SCREENING (talentum) e INVITED+manual (→ INICIADO)
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'PRE_SCREENING', 'talentum'),
              ($1, $3, 'INVITED', 'manual')`,
      [engWorker, vPre, vManual],
    );

    // Blocked em vPre (JÁ tem WJA → deve ser EXCLUÍDO por NOT EXISTS) e em vBlocked (deve aparecer).
    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
          attempt_count, first_attempted_at, last_attempted_at)
       VALUES
         ($1, $2, 'registration_incomplete', '["worker_documents"]', 'site', 1, NOW(), NOW()),
         ($1, $3, 'registration_incomplete', '["worker_documents"]', 'site', 5, NOW(), NOW())`,
      [engWorker, vPre, vBlocked],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = $1`, [engWorker]);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [engWorker]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [[vPre, vManual, vBlocked]]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [engPatientId]);
  });

  it('listEngagementsByWorker — WJA rows com kanbanStage derivado (PRE_SCREENING + INICIADO)', async () => {
    const repo = new WorkerApplicationRepository();
    const rows = await repo.listEngagementsByWorker(engWorker);
    const byVacancy = new Map(rows.map(r => [r.jobPostingId, r]));

    expect(rows).toHaveLength(2);
    expect(byVacancy.get(vPre)!.kanbanStage).toBe('PRE_SCREENING');
    expect(byVacancy.get(vPre)!.caseNumber).toBe(88881);
    expect(byVacancy.get(vPre)!.isBlocked).toBe(false);
    // INVITED + source=manual → coluna INICIADO (mesma regra do board)
    expect(byVacancy.get(vManual)!.kanbanStage).toBe('INICIADO');
  });

  it('listByWorker — blocked não-promovido vira BLOQUEADO; par que já é WJA é excluído (NOT EXISTS)', async () => {
    const repo = new BlockedApplicationQueryRepository();
    const rows = await repo.listByWorker(engWorker);

    // vPre tem WJA → excluído; só vBlocked aparece.
    expect(rows).toHaveLength(1);
    expect(rows[0].jobPostingId).toBe(vBlocked);
    expect(rows[0].kanbanStage).toBe('REJECTED');
    expect(rows[0].isBlocked).toBe(true);
    expect(rows[0].caseNumber).toBe(88883);
    expect(rows[0].attemptCount).toBe(5);
    // missing_fields_at_attempt é recomputado ON-READ (fn_worker_missing_fields) — cobertura fina
    // dessa lógica vive nos testes listByVacancy; aqui basta o shape.
    expect(Array.isArray(rows[0].missingFields)).toBe(true);
  });

  it('união WJA ∪ blocked = 3 engajamentos distintos (a realidade completa do worker)', async () => {
    const appRepo = new WorkerApplicationRepository();
    const blockedRepo = new BlockedApplicationQueryRepository();
    const [wja, blocked] = await Promise.all([
      appRepo.listEngagementsByWorker(engWorker),
      blockedRepo.listByWorker(engWorker),
    ]);
    const all = [...wja, ...blocked];
    expect(all).toHaveLength(3);
    expect(new Set(all.map(e => e.jobPostingId))).toEqual(new Set([vPre, vManual, vBlocked]));
    expect(all.filter(e => e.isBlocked)).toHaveLength(1);
  });
});
