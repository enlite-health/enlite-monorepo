/**
 * kanban-funnel-orphan-wja.test.ts
 *
 * Cobertura do fix Fase 1 (bug #1 / bug #2):
 * WJA sem encuadre correspondente (órfã) DEVE aparecer no Kanban na coluna
 * correta do seu application_funnel_stage.
 *
 * Antes do fix: GET /api/admin/vacancies/:id/funnel era `encuadres LEFT JOIN wja`
 *   → WJAs sem encuadre desapareciam do Kanban.
 * Depois do fix: `worker_job_applications LEFT JOIN LATERAL encuadres`
 *   → WJAs sempre aparecem; encuadre é OPCIONAL (enriquece dados se existir).
 *
 * Cenários:
 *   O1 — WJA órfã em INVITED    → aparece no Kanban, coluna INVITED, encuadreId=null
 *   O2 — WJA órfã em INITIATED  → aparece no Kanban, coluna INITIATED, encuadreId=null
 *   O3 — WJA órfã em IN_PROGRESS → aparece no Kanban, coluna IN_PROGRESS, encuadreId=null
 *   O4 — WJA órfã em COMPLETED  → aparece no Kanban, coluna COMPLETED, encuadreId=null
 *   O5 — WJA órfã em CONFIRMED  → aparece no Kanban, coluna CONFIRMED, encuadreId=null
 *   P1 — WJA com encuadre (controle positivo) → encuadreId preenchido, resultado intacto
 *   P2 — Totais: /funnel retorna 6 WJAs; /funnel-table também
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── IDs determinísticos (prefix kwja para evitar colisão) ────────────────────

const IDS = {
  patient:  'a1100001-0000-4000-b001-000000000001',
  vacancy:  'a1100001-0000-4000-b002-000000000001',
  wOrphan1: 'a1100001-0000-4000-b003-000000000001',
  wOrphan2: 'a1100001-0000-4000-b003-000000000002',
  wOrphan3: 'a1100001-0000-4000-b003-000000000003',
  wOrphan4: 'a1100001-0000-4000-b003-000000000004',
  wOrphan5: 'a1100001-0000-4000-b003-000000000005',
  wControl: 'a1100001-0000-4000-b003-000000000006',
};

interface KanbanCard {
  id: string;
  encuadreId: string | null;
  workerId: string;
  internalStage: string | null;
  resultado: string | null;
}

describe('GET /api/admin/vacancies/:id/funnel — WJA órfã aparece no Kanban (fix bug #1/#2)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let encuadreId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid:   'kwja-admin-e2e',
      email: 'kwja-admin@e2e.local',
      role:  'admin',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
    encuadreId = await seedFixtures(pool);
  });

  afterAll(async () => {
    await cleanFixtures(pool);
    await pool.end();
  });

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  async function getFunnelStages(): Promise<Record<string, KanbanCard[]>> {
    const res = await api.get(`/api/admin/vacancies/${IDS.vacancy}/funnel`, auth());
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    return res.data.data.stages as Record<string, KanbanCard[]>;
  }

  // ── O1-O5: WJAs órfãs aparecem em suas colunas ───────────────────────────

  it('[O1] WJA órfã em INVITED aparece na coluna INVITED com encuadreId=null', async () => {
    const stages = await getFunnelStages();
    const card = stages.INVITED.find((c) => c.workerId === IDS.wOrphan1);
    expect(card).toBeDefined();
    expect(card!.encuadreId).toBeNull();
    expect(card!.internalStage).toBe('INVITED');
  });

  it('[O2] WJA órfã em INITIATED aparece na coluna INITIATED com encuadreId=null', async () => {
    const stages = await getFunnelStages();
    const card = stages.INITIATED.find((c) => c.workerId === IDS.wOrphan2);
    expect(card).toBeDefined();
    expect(card!.encuadreId).toBeNull();
    expect(card!.internalStage).toBe('INITIATED');
  });

  it('[O3] WJA órfã em IN_PROGRESS aparece na coluna IN_PROGRESS com encuadreId=null', async () => {
    const stages = await getFunnelStages();
    const card = stages.IN_PROGRESS.find((c) => c.workerId === IDS.wOrphan3);
    expect(card).toBeDefined();
    expect(card!.encuadreId).toBeNull();
    expect(card!.internalStage).toBe('IN_PROGRESS');
  });

  it('[O4] WJA órfã em COMPLETED aparece na coluna COMPLETED com encuadreId=null', async () => {
    const stages = await getFunnelStages();
    const card = stages.COMPLETED.find((c) => c.workerId === IDS.wOrphan4);
    expect(card).toBeDefined();
    expect(card!.encuadreId).toBeNull();
    expect(card!.internalStage).toBe('COMPLETED');
  });

  it('[O5] WJA órfã em CONFIRMED aparece na coluna CONFIRMED com encuadreId=null', async () => {
    const stages = await getFunnelStages();
    const card = stages.CONFIRMED.find((c) => c.workerId === IDS.wOrphan5);
    expect(card).toBeDefined();
    expect(card!.encuadreId).toBeNull();
    expect(card!.internalStage).toBe('CONFIRMED');
  });

  // ── P1: Controle positivo preserva dados do encuadre ─────────────────────

  it('[P1] WJA com encuadre tem encuadreId preenchido e resultado=PENDIENTE intacto', async () => {
    const stages = await getFunnelStages();
    const card = stages.INVITED.find((c) => c.workerId === IDS.wControl);
    expect(card).toBeDefined();
    expect(card!.encuadreId).toBe(encuadreId);
    expect(card!.resultado).toBe('PENDIENTE');
  });

  // ── P2: Totais consistentes entre /funnel e /funnel-table ────────────────

  it('[P2] /funnel retorna 6 WJAs e /funnel-table.counts.ALL === 6', async () => {
    const stages = await getFunnelStages();
    const totalKanban = Object.values(stages).flat().length;
    expect(totalKanban).toBe(6);

    const tableRes = await api.get(
      `/api/admin/vacancies/${IDS.vacancy}/funnel-table`,
      auth(),
    );
    expect(tableRes.status).toBe(200);
    expect(tableRes.data.data.counts.ALL).toBe(6);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Seeds all test fixtures and returns the encuadreId of the control-positive record.
 */
async function seedFixtures(pool: Pool): Promise<string> {
  await cleanFixtures(pool);

  // Patient
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name, status)
     VALUES ($1, 'kwja-e2e-task-001', 'AR', 'KwjaTest', 'Patient', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.patient],
  );

  // Vacancy (vacancy_number from sequence)
  const vnRes = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn = parseInt(vnRes.rows[0].vn);

  await pool.query(
    `INSERT INTO job_postings
       (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 98001, $3, 'kwja-e2e-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.vacancy, vn, IDS.patient],
  );

  // Workers (6 total; source=talentum on WJA bypasses INCOMPLETE_REGISTER guard)
  const workerIds = [
    IDS.wOrphan1, IDS.wOrphan2, IDS.wOrphan3,
    IDS.wOrphan4, IDS.wOrphan5, IDS.wControl,
  ];
  for (const [idx, wid] of workerIds.entries()) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [wid, `kwja-worker-${idx + 1}`, `kwja-w${idx + 1}@e2e.local`, `+549110099${idx + 1}000`],
    );
  }

  // WJAs for 5 "orphans" — disable Fase 2 trigger so encuadres are NOT auto-created.
  // This preserves the Fase 1 test scenario: WJAs without encuadres must still appear
  // in the Kanban (query inversion fix). Fase 2 trigger is tested separately in
  // kanban-fase2-invariant.test.ts.
  await pool.query(
    'ALTER TABLE worker_job_applications DISABLE TRIGGER trg_ensure_encuadre_on_wja_insert',
  );

  const orphanRows: Array<{ id: string; stage: string }> = [
    { id: IDS.wOrphan1, stage: 'INVITED' },
    { id: IDS.wOrphan2, stage: 'INITIATED' },
    { id: IDS.wOrphan3, stage: 'IN_PROGRESS' },
    { id: IDS.wOrphan4, stage: 'COMPLETED' },
    { id: IDS.wOrphan5, stage: 'CONFIRMED' },
  ];

  for (const { id, stage } of orphanRows) {
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, $3, 'talentum')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [id, IDS.vacancy, stage],
    );
  }

  await pool.query(
    'ALTER TABLE worker_job_applications ENABLE TRIGGER trg_ensure_encuadre_on_wja_insert',
  );

  // WJA for control positive (INVITED)
  await pool.query(
    `INSERT INTO worker_job_applications
       (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, 'INVITED', 'talentum')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.wControl, IDS.vacancy],
  );

  // Encuadre ONLY for control positive worker — verifies enrichment still works.
  // O trigger trg_ensure_encuadre_on_wja_insert pode já ter criado um encuadre ao
  // inserir a WJA do wControl. Usar ON CONFLICT para obter o id existente (ou criar).
  const encRes = await pool.query<{ id: string }>(
    `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado)
     VALUES ($1, $2, 'Worker Control Positivo', 'PENDIENTE')
     ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
       worker_raw_name = EXCLUDED.worker_raw_name,
       resultado = EXCLUDED.resultado
     RETURNING id`,
    [IDS.wControl, IDS.vacancy],
  );

  return encRes.rows[0].id;
}

async function cleanFixtures(pool: Pool): Promise<void> {
  const workerIds = [
    IDS.wOrphan1, IDS.wOrphan2, IDS.wOrphan3,
    IDS.wOrphan4, IDS.wOrphan5, IDS.wControl,
  ];

  await pool.query(
    `DELETE FROM encuadres WHERE job_posting_id = $1`,
    [IDS.vacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE job_posting_id = $1`,
    [IDS.vacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM job_postings WHERE id = $1`,
    [IDS.vacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id = ANY($1)`,
    [workerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM patients WHERE id = $1`,
    [IDS.patient],
  ).catch(() => {});
}
