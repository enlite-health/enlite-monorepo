/**
 * merged-worker-applications.e2e.test.ts
 *
 * Regressão do caso Norma Araujo (13/08, CASO 762-469): a MESMA prestadora
 * aparecia duas vezes no Kanban da mesma vaga — um card em "Confirmados" e
 * outro em "Completado" — e mover um não movia o outro.
 *
 * A trava contra postulação dupla (`UNIQUE (worker_id, job_posting_id)`) existe,
 * mas é por ID de worker: a pessoa tinha dois cadastros, um já fundido no outro,
 * e o webhook do Talentum escrevia no morto. Dois IDs da mesma pessoa passam
 * pelos dois lados da constraint.
 *
 * Sem mocks. Banco real — é o único jeito de provar isto: o CASCADE das FKs, o
 * guard `enforce_worker_registered_for_application` e a própria constraint são
 * invariantes de banco, invisíveis para teste mockado.
 *
 * Cobre a reconciliação (`ReconcileMergedWorkerApplications`):
 *   1. duplicado → descarta a fantasma e a pessoa fica com UM card na vaga
 *   2. a trilha de etapas da fantasma sobrevive (FK ON DELETE CASCADE)
 *   3. as notas de contato sobrevivem e seguem aparecendo no card
 *   4. o score do Talentum é preservado; a etapa do funil NÃO regride
 *   5. órfão → reparentado, não descartado (é candidatura real)
 *   6. rollback devolve o estado anterior
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';
import {
  findMergedOrphans,
  reconcileRow,
  rollbackRow,
  bypassRegisteredGuard,
  ReconcileRowError,
  ReconcileEffects,
} from '../../src/modules/matching/application/ReconcileMergedWorkerApplications';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STAMP = `merged_${Date.now()}`;

describe('Reconciliação de postulações presas em cadastro fundido', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;

  /** Vaga onde a pessoa tem DUAS postulações (o bug). */
  let dupVacancyId: string;
  /** Vaga onde só o cadastro morto tem postulação (órfã). */
  let orphanVacancyId: string;

  let survivorId: string;
  let mergedId: string;

  let survivingWjaId: string;
  let ghostWjaId: string;
  let orphanWjaId: string;

  /** Filhos movidos em cada reconciliação — o rollback precisa deles. */
  let ghostEffects: ReconcileEffects = { movedHistoryIds: [], movedNoteIds: [] };
  let orphanEffects: ReconcileEffects = { movedHistoryIds: [], movedNoteIds: [] };
  /** Linha inteira da fantasma, como o snapshot do CLI guarda. */
  let ghostSnapshot: Record<string, unknown> = {};

  async function insertWorker(suffix: string): Promise<string> {
    const res = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`uid-${STAMP}-${suffix}`, `${STAMP}-${suffix}@merged.test`],
    );
    return res.rows[0].id as string;
  }

  async function insertVacancy(caseNumber: number): Promise<string> {
    const res = await pool.query(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ($1, 'AR', 'SEARCHING', $2, $3) RETURNING id`,
      [`Caso E2E merged ${caseNumber}`, patientId, caseNumber],
    );
    return res.rows[0].id as string;
  }

  /** source='talentum' passa pelo guard de INCOMPLETE_REGISTER, como em prod. */
  async function insertApplication(
    workerId: string,
    vacancyId: string,
    stage: string,
    matchScore: number | null,
  ): Promise<string> {
    const res = await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, match_score, source)
       VALUES ($1, $2, $3, $4, 'talentum') RETURNING id`,
      [workerId, vacancyId, stage, matchScore],
    );
    return res.rows[0].id as string;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: `merged-admin-${STAMP}`,
      email: `merged-admin-${STAMP}@e2e.local`,
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'merged-dup');

    dupVacancyId = await insertVacancy(99983);
    orphanVacancyId = await insertVacancy(99984);

    survivorId = await insertWorker('survivor');
    mergedId = await insertWorker('merged');
    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [survivorId, mergedId]);

    // O caso real: duas postulações na mesma vaga, uma em cada cadastro.
    survivingWjaId = await insertApplication(survivorId, dupVacancyId, 'CONFIRMED', null);
    ghostWjaId = await insertApplication(mergedId, dupVacancyId, 'QUALIFIED', 6.6);
    // E uma postulação que só existe no cadastro morto.
    orphanWjaId = await insertApplication(mergedId, orphanVacancyId, 'QUALIFIED', 8.1);

    // Nota de contato escrita enquanto o card apontava para o cadastro morto.
    await pool.query(
      `INSERT INTO wja_contact_notes
         (worker_job_application_id, worker_id, job_posting_id, note_text, created_by_admin_id)
       VALUES ($1, $2, $3, 'llamada sin respuesta', $4)`,
      [ghostWjaId, mergedId, dupVacancyId, `admin-${STAMP}`],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    const ids = [survivorId, mergedId].filter(Boolean);
    const vacancies = [dupVacancyId, orphanVacancyId].filter(Boolean);
    await pool.query(`DELETE FROM wja_contact_notes WHERE job_posting_id = ANY($1::uuid[])`, [vacancies]);
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [vacancies]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.end();
  });

  // ── O bug, antes do conserto ────────────────────────────────────────────────

  it('a constraint NÃO impede duas postulações da mesma pessoa na mesma vaga', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM worker_job_applications WHERE job_posting_id = $1`,
      [dupVacancyId],
    );
    expect(rows[0].n).toBe(2);

    const res = await api.get(`/api/admin/vacancies/${dupVacancyId}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cards = Object.values(
      res.data.data.stages as Record<string, Array<Record<string, unknown>>>,
    ).flat();
    // Dois cards, uma pessoa só — exatamente a foto que o time mandou.
    expect(cards.filter((c) => c.workerId === survivorId)).toHaveLength(1);
    expect(cards.filter((c) => c.workerId === mergedId)).toHaveLength(1);
  });

  it('classifica duplicado × órfão corretamente', async () => {
    const orphans = await findMergedOrphans(pool);
    const mine = orphans.filter((o) => o.deadWorkerId === mergedId && o.kind === 'application');

    const dup = mine.find((o) => o.jobPostingId === dupVacancyId);
    const orphan = mine.find((o) => o.jobPostingId === orphanVacancyId);

    expect(dup?.duplicate).toBe(true);
    expect(dup?.canonicalWorkerId).toBe(survivorId);
    expect(orphan?.duplicate).toBe(false);

    ghostSnapshot = dup!.snapshot; // o CLI guarda isto para o rollback
  });

  // ── O conserto ──────────────────────────────────────────────────────────────

  it('reconcilia: um card por pessoa, sem perder trilha, nota nem score', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM worker_job_application_stage_history WHERE application_id = $1`,
      [ghostWjaId],
    );
    expect(before.rows[0].n).toBeGreaterThan(0); // a fantasma tem trilha a preservar

    const orphans = (await findMergedOrphans(pool)).filter((o) => o.deadWorkerId === mergedId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bypassRegisteredGuard(client);
      for (const row of orphans.filter((o) => o.kind === 'application')) {
        const eff = await reconcileRow(client, row);
        if (row.jobPostingId === dupVacancyId) ghostEffects = eff;
        if (row.jobPostingId === orphanVacancyId) orphanEffects = eff;
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // 1. a fantasma sumiu, a canônica ficou
    const remaining = await pool.query(
      `SELECT id, application_funnel_stage AS stage, match_score
         FROM worker_job_applications WHERE job_posting_id = $1`,
      [dupVacancyId],
    );
    expect(remaining.rows).toHaveLength(1);
    expect(remaining.rows[0].id).toBe(survivingWjaId);

    // 2. a etapa NÃO regrediu (CONFIRMED vence QUALIFIED)...
    expect(remaining.rows[0].stage).toBe('CONFIRMED');
    // ...e o score do Talentum foi preservado no buraco.
    expect(Number(remaining.rows[0].match_score)).toBe(6.6);

    // 3. a trilha da fantasma sobreviveu ao CASCADE
    const history = await pool.query(
      `SELECT COUNT(*)::int AS n FROM worker_job_application_stage_history WHERE application_id = $1`,
      [survivingWjaId],
    );
    expect(history.rows[0].n).toBeGreaterThanOrEqual(before.rows[0].n + 1);

    // 4. a nota sobreviveu e segue visível no card (lida por worker+vaga)
    const notes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM wja_contact_notes
        WHERE worker_id = $1 AND job_posting_id = $2`,
      [survivorId, dupVacancyId],
    );
    expect(notes.rows[0].n).toBe(1);

    // 5. a órfã foi reparentada, não descartada
    const orphan = await pool.query(
      `SELECT worker_id FROM worker_job_applications WHERE id = $1`,
      [orphanWjaId],
    );
    expect(orphan.rows[0].worker_id).toBe(survivorId);
  });

  it('o Kanban passa a mostrar UM card da pessoa', async () => {
    const res = await api.get(`/api/admin/vacancies/${dupVacancyId}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cards = Object.values(
      res.data.data.stages as Record<string, Array<Record<string, unknown>>>,
    ).flat();

    expect(cards.filter((c) => c.workerId === mergedId)).toHaveLength(0);
    expect(cards.filter((c) => c.workerId === survivorId)).toHaveLength(1);
    // A nota preservada continua contando no card.
    const card = cards.find((c) => c.workerId === survivorId)!;
    expect(card.contactNotesCount).toBe(1);
  });

  it('rollback devolve a órfã — e as notas junto com ela', async () => {
    const orphanRow = {
      kind: 'application' as const,
      rowId: orphanWjaId,
      deadWorkerId: mergedId,
      canonicalWorkerId: survivorId,
      jobPostingId: orphanVacancyId,
      vacancyTitle: null,
      stage: null,
      matchScore: null,
      duplicate: false,
      snapshot: {},
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bypassRegisteredGuard(client);
      const reverted = await rollbackRow(client, orphanRow, orphanEffects);
      expect(reverted).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = await pool.query(`SELECT worker_id FROM worker_job_applications WHERE id = $1`, [
      orphanWjaId,
    ]);
    expect(after.rows[0].worker_id).toBe(mergedId);
  });

  it('rollback da duplicada recria a linha E devolve trilha e notas', async () => {
    const ghostRow = {
      kind: 'application' as const,
      rowId: ghostWjaId,
      deadWorkerId: mergedId,
      canonicalWorkerId: survivorId,
      jobPostingId: dupVacancyId,
      vacancyTitle: null,
      stage: null,
      matchScore: null,
      duplicate: true,
      snapshot: ghostSnapshot,
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bypassRegisteredGuard(client);
      expect(await rollbackRow(client, ghostRow, ghostEffects)).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // A linha voltou com o mesmo id...
    const back = await pool.query(
      `SELECT worker_id FROM worker_job_applications WHERE id = $1`,
      [ghostWjaId],
    );
    expect(back.rows[0].worker_id).toBe(mergedId);

    // ...e a trilha e a nota voltaram com ela, em vez de ficarem no candidato
    // errado (o que deixaria o estado PIOR que antes do backfill).
    const history = await pool.query(
      `SELECT COUNT(*)::int AS n FROM worker_job_application_stage_history WHERE application_id = $1`,
      [ghostWjaId],
    );
    expect(history.rows[0].n).toBeGreaterThan(0);

    const note = await pool.query(
      `SELECT worker_id, worker_job_application_id FROM wja_contact_notes
        WHERE job_posting_id = $1`,
      [dupVacancyId],
    );
    expect(note.rows[0].worker_id).toBe(mergedId);
    expect(note.rows[0].worker_job_application_id).toBe(ghostWjaId);
  });

  it('encuadre duplicado: funde os campos, preserva o dedup_hash de quem fica e some', async () => {
    // Os encuadres nascem do trigger trg_ensure_encuadre_on_wja_insert. Aqui a
    // reconciliação das WJAs já rodou, então recriamos o par para exercitar
    // especificamente o caminho do encuadre — que tem UNIQUE (worker,vaga) E
    // UNIQUE (dedup_hash), a combinação que fazia o UPDATE estourar 23505.
    const ghost = await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, recruiter_name, dedup_hash)
       VALUES ($1, $2, 'Fantasma E2E', 'reclutadora X', $3)
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE
         SET recruiter_name = EXCLUDED.recruiter_name
       RETURNING id`,
      [mergedId, dupVacancyId, `dedup-${STAMP}-ghost`],
    );
    const ghostEncuadreId = ghost.rows[0].id as string;

    const survivor = await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, dedup_hash)
       VALUES ($1, $2, 'Sobrevivente E2E', $3)
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE
         SET worker_raw_name = EXCLUDED.worker_raw_name
       RETURNING id, dedup_hash`,
      [survivorId, dupVacancyId, `dedup-${STAMP}-survivor`],
    );
    const survivorEncuadreId = survivor.rows[0].id as string;
    const survivorHash = survivor.rows[0].dedup_hash as string;

    const row = (await findMergedOrphans(pool)).find(
      (o) => o.kind === 'encuadre' && o.rowId === ghostEncuadreId,
    );
    expect(row?.duplicate).toBe(true);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bypassRegisteredGuard(client);
      await reconcileRow(client, row!);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = await pool.query(
      `SELECT id, recruiter_name, dedup_hash FROM encuadres WHERE job_posting_id = $1`,
      [dupVacancyId],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].id).toBe(survivorEncuadreId);
    // campo que só a fantasma tinha foi preservado...
    expect(after.rows[0].recruiter_name).toBe('reclutadora X');
    // ...e o dedup_hash NÃO foi copiado (é UNIQUE — copiar estoura 23505).
    expect(after.rows[0].dedup_hash).toBe(survivorHash);
  });

  it('marcada como duplicada sem canônico na vaga → falha, não apaga', async () => {
    // Estado impossível de propósito: simula CSV antigo ou merge concorrente.
    // O perigo é o DELETE cascatear a ÚNICA postulação da pessoa.
    const bogus = {
      kind: 'application' as const,
      rowId: orphanWjaId,
      deadWorkerId: mergedId,
      canonicalWorkerId: survivorId,
      jobPostingId: orphanVacancyId, // canônico NÃO tem linha aqui
      vacancyTitle: null,
      stage: null,
      matchScore: null,
      duplicate: true,
      snapshot: {},
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bypassRegisteredGuard(client);
      await expect(reconcileRow(client, bogus)).rejects.toThrow(ReconcileRowError);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const still = await pool.query(
      `SELECT COUNT(*)::int AS n FROM worker_job_applications WHERE id = $1`,
      [orphanWjaId],
    );
    expect(still.rows[0].n).toBe(1);
  });
});
