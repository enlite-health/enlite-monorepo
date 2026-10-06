/**
 * postularse-iniciado-043.e2e.test.ts
 *
 * Spec 043 (D474) — banco REAL, sem API (acessa o pool e chama os use cases direto, como
 * blocked-application-repos.integration.test.ts):
 *
 *   M6/M6a  CreateManualWjaWithEncuadreUseCase (o clique em "Postularse"):
 *           - linha do sistema INVITED (convite/match) → source vira 'manual' (coluna INICIADO)
 *             e UMA linha de histórico (field_name='source', ator worker_self:);
 *           - PRE_SCREENING, SELECTED e REJECTED → NADA muda (nem source, nem histórico);
 *           - segundo clique não grava uma segunda linha de histórico.
 *   M6b     leituras irmãs: a WJA pré-Iniciado do par com tentativa bloqueada some; o bloqueado fica.
 *   Promo   PromoteBlockedApplicationsUseCase: convite do sistema não bloqueia a promoção;
 *           WJA à frente continua `wja_already_exists`.
 *
 * INVARIANTE: migrations até 478 aplicadas (histórico com changed_by) e 183 (guard REGISTERED).
 */

import { Pool, PoolClient } from 'pg';
import { CreateManualWjaWithEncuadreUseCase } from '../../src/modules/matching/application/CreateManualWjaWithEncuadreUseCase';
import { PromoteBlockedApplicationsUseCase } from '../../src/modules/matching/application/PromoteBlockedApplicationsUseCase';
import { BlockedApplicationQueryRepository } from '../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository';
import { deriveKanbanColumn } from '../../src/modules/matching/domain/kanbanColumn';
import { FunnelTableRepository } from '../../src/modules/matching/infrastructure/FunnelTableRepository';
import { loadStageCounts } from '../../src/modules/matching/interfaces/controllers/vacancyListHelpers';
import { WJAFunnelController } from '../../src/modules/matching/interfaces/controllers/WJAFunnelController';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });
const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const workerIds: string[] = [];
const vacancyIds: string[] = [];
let patientId: string;
let caseSeq = 77000 + Math.floor(Math.random() * 900);

async function makeWorker(tag: string): Promise<string> {
  // REGISTERED: o guard da migration 183 só deixa WJA entrar para worker completo.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-043-${SUFFIX}-${tag}`, `p043-${SUFFIX}-${tag}@postularse.test`],
  );
  workerIds.push(rows[0].id);
  return rows[0].id;
}

async function makeVacancy(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, is_draft, patient_id, case_number)
     VALUES ('Vaga 043', 'AR', 'SEARCHING', false, $1, $2) RETURNING id`,
    [patientId, ++caseSeq],
  );
  vacancyIds.push(rows[0].id);
  return rows[0].id;
}

async function seedWja(workerId: string, vacancyId: string, stage: string, source: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO worker_job_applications
       (worker_id, job_posting_id, application_funnel_stage, source, messaged_at)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
    [workerId, vacancyId, stage, source],
  );
  return rows[0].id;
}

async function seedBlocked(workerId: string, vacancyId: string, dismissed = false): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO worker_blocked_applications
       (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
        attempt_count, first_attempted_at, last_attempted_at, dismissed_at)
     VALUES ($1, $2, 'registration_incomplete', '["worker_documents"]', 'site', 1, NOW(), NOW(),
             CASE WHEN $3::boolean THEN NOW() ELSE NULL END)
     RETURNING id`,
    [workerId, vacancyId, dismissed],
  );
  return rows[0].id;
}

/** O clique: o mesmo use case do track-channel, numa transação com o ator `worker_self:` (como o withActorContext). */
async function click(workerId: string, vacancyId: string): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_uid', $1, true)`, [`worker_self:${workerId}`]);
    await new CreateManualWjaWithEncuadreUseCase().execute(client, {
      workerId,
      jobPostingId: vacancyId,
      acquisitionChannel: 'portal',
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function wjaOf(workerId: string, vacancyId: string) {
  const { rows } = await pool.query(
    `SELECT id, application_funnel_stage AS stage, source FROM worker_job_applications
     WHERE worker_id = $1 AND job_posting_id = $2`,
    [workerId, vacancyId],
  );
  return rows[0] as { id: string; stage: string; source: string };
}

async function sourceHistory(applicationId: string) {
  const { rows } = await pool.query(
    `SELECT field_name, old_value, new_value, changed_by FROM worker_job_application_stage_history
     WHERE application_id = $1 AND field_name = 'source' ORDER BY created_at`,
    [applicationId],
  );
  return rows as Array<{ field_name: string; old_value: string | null; new_value: string; changed_by: string | null }>;
}

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'E2E', 'Postularse043', 'AR', 'ACTIVE') RETURNING id`,
    [`e2e-043-${SUFFIX}`],
  );
  patientId = rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [vacancyIds]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [workerIds]);
  await pool.end();
});

describe('M6 — o clique em Postularse leva o convidado a INICIADO (banco real)', () => {
  it('linha do sistema INVITED → clique → source=manual, coluna INICIADO, UMA linha de histórico', async () => {
    const w = await makeWorker('m6');
    const v = await makeVacancy();
    const wjaId = await seedWja(w, v, 'INVITED', 'system');
    const antes = await wjaOf(w, v);
    expect(deriveKanbanColumn(antes.stage, antes.source, new Date())).toBe('INVITED');

    await click(w, v);

    const depois = await wjaOf(w, v);
    expect(depois.id).toBe(wjaId); // a MESMA linha, não uma nova
    expect(depois.stage).toBe('INVITED');
    expect(depois.source).toBe('manual');
    expect(deriveKanbanColumn(depois.stage, depois.source, new Date())).toBe('INICIADO');

    const hist = await sourceHistory(wjaId);
    expect(hist).toEqual([
      { field_name: 'source', old_value: 'system', new_value: 'manual', changed_by: `worker_self:${w}` },
    ]);
  });

  it('segundo clique não grava outra linha de histórico (já é manual)', async () => {
    const w = await makeWorker('m6-2x');
    const v = await makeVacancy();
    const wjaId = await seedWja(w, v, 'INVITED', 'system');

    await click(w, v);
    await click(w, v);

    expect(await sourceHistory(wjaId)).toHaveLength(1);
  });

  it('sem linha prévia: cria a WJA manual e NÃO grava histórico de source (nada mudou, nasceu)', async () => {
    const w = await makeWorker('m6-novo');
    const v = await makeVacancy();

    await click(w, v);

    const wja = await wjaOf(w, v);
    expect(wja.source).toBe('manual');
    expect(await sourceHistory(wja.id)).toHaveLength(0);
  });

  it.each(['PRE_SCREENING', 'SELECTED', 'REJECTED'])(
    'M6a — %s do sistema → clique → INALTERADO (etapa, source e histórico)',
    async (stage) => {
      const w = await makeWorker(`m6a-${stage}`);
      const v = await makeVacancy();
      const wjaId = await seedWja(w, v, stage, 'system');

      await click(w, v);

      const depois = await wjaOf(w, v);
      expect(depois.stage).toBe(stage);
      expect(depois.source).toBe('system');
      expect(await sourceHistory(wjaId)).toHaveLength(0);
    },
  );
});

describe('M6b — um worker, um card por vaga (leituras irmãs, banco real)', () => {
  it('convite do sistema + tentativa bloqueada: o bloqueado aparece, a WJA some da ficha; sem bloqueio a WJA aparece', async () => {
    const w = await makeWorker('m6b');
    const vPar = await makeVacancy(); // convite + bloqueio
    const vSo = await makeVacancy(); // só convite
    await seedWja(w, vPar, 'INVITED', 'system');
    await seedWja(w, vSo, 'INVITED', 'system');
    await seedBlocked(w, vPar);

    const blockedRepo = new BlockedApplicationQueryRepository();
    const blocked = await blockedRepo.listByVacancy(vPar);
    expect(blocked.map((b) => b.workerId)).toEqual([w]); // o convite NÃO esconde o bloqueado

    const { WorkerApplicationRepository } = await import(
      '../../src/modules/matching/infrastructure/WorkerApplicationRepository'
    );
    const eng = await new WorkerApplicationRepository().listEngagementsByWorker(w);
    expect(eng.map((e) => e.jobPostingId)).toEqual([vSo]); // a WJA do par bloqueado some
    const doWorker = await blockedRepo.listByWorker(w);
    expect(doWorker.map((b) => [b.jobPostingId, b.kanbanStage])).toEqual([[vPar, 'INICIADO']]);
  });

  it('WJA à frente (PRE_SCREENING) do par: o bloqueado é que some (comportamento de sempre)', async () => {
    const w = await makeWorker('m6b-frente');
    const v = await makeVacancy();
    await seedWja(w, v, 'PRE_SCREENING', 'system');
    await seedBlocked(w, v);

    expect(await new BlockedApplicationQueryRepository().listByVacancy(v)).toHaveLength(0);
  });
});

describe('M2/E3/M6b — Kanban, contagem e tabela leem o MESMO recorte (banco real)', () => {
  it('par convite+bloqueio: 1 card (bloqueado) em INICIADO no Kanban; contagem INICIADO=1 e INVITED=0; tabela só a linha bloqueada', async () => {
    const wPar = await makeWorker('kb-par');
    const wDisp = await makeWorker('kb-disp');
    const wLivre = await makeWorker('kb-livre');
    const v = await makeVacancy();
    await seedWja(wPar, v, 'INVITED', 'system');
    await seedBlocked(wPar, v); // ativa → INICIADO, esconde o convite
    await seedWja(wDisp, v, 'INVITED', 'system');
    await seedBlocked(wDisp, v, true); // dispensada → REJECTED, também esconde o convite
    await seedWja(wLivre, v, 'INVITED', 'system'); // convite sem bloqueio → continua em INVITED

    // 1) Kanban (controller com o SQL real)
    const json = jest.fn().mockReturnThis();
    const res = { json, status: jest.fn().mockReturnThis() };
    await new WJAFunnelController().getEncuadreFunnel({ params: { id: v } } as never, res as never);
    const { stages } = json.mock.calls[0][0].data as {
      stages: Record<string, Array<{ workerId: string; isBlocked?: boolean; isDismissed?: boolean }>>;
    };
    expect(stages.INICIADO.map((c) => [c.workerId, c.isBlocked])).toEqual([[wPar, true]]);
    expect(stages.REJECTED.map((c) => [c.workerId, c.isBlocked, c.isDismissed])).toEqual([[wDisp, true, true]]);
    expect(stages.INVITED.map((c) => c.workerId)).toEqual([wLivre]);

    // 2) Contagem da lista de vagas (loadStageCounts)
    const counts = (await loadStageCounts(pool, [v])).get(v)!;
    expect(counts.INICIADO).toBe(1);
    expect(counts.REJECTED).toBe(1);
    expect(counts.INVITED).toBe(1);

    // 3) Tabela (FunnelTableRepository): WJA sem as escondidas; bloqueadas com is_dismissed
    const repo = new FunnelTableRepository();
    const raw = await repo.fetchRawRows(v);
    expect(raw.map((r) => r.worker_id)).toEqual([wLivre]);
    const blocked = await repo.fetchBlockedRawRows(v);
    expect(blocked.map((r) => [r.worker_id, r.is_dismissed]).sort()).toEqual(
      [[wPar, false], [wDisp, true]].sort(),
    );
  });
});

describe('Promoção do bloqueado (banco real)', () => {
  it('convite do sistema do par NÃO bloqueia: promove, a WJA vira manual e a tentativa fica promovida', async () => {
    const w = await makeWorker('promo');
    const v = await makeVacancy();
    const wjaId = await seedWja(w, v, 'INVITED', 'system');
    const blockedId = await seedBlocked(w, v);

    const result = await new PromoteBlockedApplicationsUseCase(pool).execute(w);

    expect(result).toEqual({ promoted: 1, skipped: 0, reasons: {} });
    const depois = await wjaOf(w, v);
    expect(depois.id).toBe(wjaId);
    expect(depois.source).toBe('manual');
    const { rows } = await pool.query(
      `SELECT promoted_at, promoted_wja_id FROM worker_blocked_applications WHERE id = $1`,
      [blockedId],
    );
    expect(rows[0].promoted_at).not.toBeNull();
    expect(rows[0].promoted_wja_id).toBe(wjaId);
    expect(await sourceHistory(wjaId)).toHaveLength(1);
  });

  it('WJA à frente (PRE_SCREENING) → wja_already_exists, nada muda', async () => {
    const w = await makeWorker('promo-frente');
    const v = await makeVacancy();
    const wjaId = await seedWja(w, v, 'PRE_SCREENING', 'system');
    const blockedId = await seedBlocked(w, v);

    const result = await new PromoteBlockedApplicationsUseCase(pool).execute(w);

    expect(result).toEqual({ promoted: 0, skipped: 1, reasons: { wja_already_exists: 1 } });
    expect((await wjaOf(w, v)).source).toBe('system');
    expect(await sourceHistory(wjaId)).toHaveLength(0);
    const { rows } = await pool.query(`SELECT promoted_at FROM worker_blocked_applications WHERE id = $1`, [blockedId]);
    expect(rows[0].promoted_at).toBeNull();
  });
});
