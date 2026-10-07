/**
 * cadastro-completo-043.e2e.test.ts
 *
 * Spec 043, adendo A1-A4 (07/10) — banco REAL, sem API e sem Pub/Sub (o handler do evento é chamado
 * direto). KMS e blind index são stubs de passagem: a prova aqui é de banco e de regra, não de cripto.
 *
 *   A1  admin completa o cadastro de worker bloqueado em DUAS vagas → status REGISTERED + 1 linha
 *       `worker.registration_completed` → promoção → as 2 tentativas promovidas e as 2 vagas em INICIADO normal.
 *   A2  tentativa DISPENSADA + cadastro completo → a varredura não promove; o card segue em REJECTED.
 *   A4  worker com 2 áreas de atendimento → 1 card no Kanban; o total do Kanban = counts.columns da funnel-table.
 *
 * INVARIANTE: migrations até 499 aplicadas.
 */

import { Pool } from 'pg';

const mockDatabaseUrl =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const mockPool = new Pool({ connectionString: mockDatabaseUrl });

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => mockPool }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: async (v: string | null) => (v ? `ENC(${v})` : null),
    decrypt: async (v: string | null) => (v ? 'Nome Teste' : ''),
    encryptBatch: async (f: Record<string, string>) =>
      Object.fromEntries(Object.keys(f).map((k) => [k, `ENC(${k})`])),
  })),
}));
jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({
    generateNameTrigramBidx: async () => [],
    generateValuesBidx: async () => [],
    serializeForPg: () => '{}',
  })),
}));

import { UpdateWorkerProfileFieldsUseCase } from '../../src/modules/worker/application/UpdateWorkerProfileFieldsUseCase';
import { PromoteBlockedApplicationsUseCase } from '../../src/modules/matching/application/PromoteBlockedApplicationsUseCase';
import { createPromoteBlockedApplicationsHandler } from '../../src/modules/matching/application/PromoteBlockedApplicationsEventHandler';
import { GetFunnelTableUseCase } from '../../src/modules/matching/application/GetFunnelTableUseCase';
import { WJAFunnelController } from '../../src/modules/matching/interfaces/controllers/WJAFunnelController';

const pool = mockPool;
const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const workerIds: string[] = [];
const vacancyIds: string[] = [];
let patientId: string;
let caseSeq = 78000 + Math.floor(Math.random() * 900);
let phoneSeq = Math.floor(Math.random() * 9e6);

type Card = { id: string; workerId: string | null; isBlocked?: boolean; isDismissed?: boolean };

async function makeVacancy(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, is_draft, patient_id, case_number)
     VALUES ('Vaga 043 adendo', 'AR', 'SEARCHING', false, $1, $2) RETURNING id`,
    [patientId, ++caseSeq],
  );
  vacancyIds.push(rows[0].id);
  return rows[0].id;
}

/** REGISTERED simples (como o e2e irmão): só para quem precisa de WJA/promoção. */
async function makeRegisteredWorker(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-043b-${SUFFIX}-${tag}`, `p043b-${SUFFIX}-${tag}@postularse.test`],
  );
  workerIds.push(rows[0].id);
  return rows[0].id;
}

/**
 * Worker com TUDO que o recálculo de status exige, MENOS `profession` — e `INCOMPLETE_REGISTER`.
 * Quem preencher `profession` (o admin) completa o cadastro.
 */
async function makeAlmostCompleteWorker(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (
       auth_uid, email, status, country, timezone, phone,
       first_name_encrypted, last_name_encrypted, sex_encrypted, gender_encrypted,
       birth_date_encrypted, document_number_encrypted, document_type, languages_encrypted,
       knowledge_level, title_certificate, years_experience,
       experience_types, preferred_types, preferred_age_range)
     VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires', $3,
       'enc', 'enc', 'enc', 'enc', 'enc', 'enc', 'DNI', 'enc',
       'BASIC', 'DEGREE', '3-5',
       ARRAY['TEA'], ARRAY['TEA'], ARRAY['CHILD'])
     RETURNING id`,
    [`uid-043b-${SUFFIX}-${tag}`, `p043b-${SUFFIX}-${tag}@postularse.test`, `+54911${String(++phoneSeq).padStart(7, '0')}`],
  );
  const id = rows[0].id;
  workerIds.push(id);
  await pool.query(
    `INSERT INTO worker_service_areas (worker_id, address_line, radius_km) VALUES ($1, 'Av. Corrientes 1234', 10)`,
    [id],
  );
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
     VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
    [id],
  );
  await pool.query(
    `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url, resume_cv_url, at_certificate_url)
     VALUES ($1, 'http://e.com/id', 'http://e.com/cr', 'http://e.com/cv', 'http://e.com/cert')`,
    [id],
  );
  return id;
}

async function seedBlocked(workerId: string, vacancyId: string, dismissed = false): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO worker_blocked_applications
       (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
        attempt_count, first_attempted_at, last_attempted_at, dismissed_at, dismissed_reason)
     VALUES ($1, $2, 'registration_incomplete', '["profession"]', 'site', 1, NOW(), NOW(),
             CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
             CASE WHEN $3::boolean THEN 'OTHER' ELSE NULL END)
     RETURNING id`,
    [workerId, vacancyId, dismissed],
  );
  return rows[0].id;
}

async function funnel(vacancyId: string): Promise<Record<string, Card[]>> {
  const json = jest.fn().mockReturnThis();
  const res = { json, status: jest.fn().mockReturnThis() };
  await new WJAFunnelController().getEncuadreFunnel({ params: { id: vacancyId } } as never, res as never);
  return json.mock.calls[0][0].data.stages as Record<string, Card[]>;
}

const cardsOf = (stages: Record<string, Card[]>, workerId: string) =>
  Object.entries(stages).flatMap(([col, cs]) => cs.filter((c) => c.workerId === workerId).map((c) => ({ col, ...c })));

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'E2E', 'Adendo043', 'AR', 'ACTIVE') RETURNING id`,
    [`e2e-043b-${SUFFIX}`],
  );
  patientId = rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [vacancyIds]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
  await pool.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [workerIds]);
  await pool.end();
});

describe('A1 — o admin completa o cadastro: TODAS as vagas bloqueadas do worker viram Iniciado normal', () => {
  it('bloqueado em 2 vagas → admin preenche o campo que faltava → REGISTERED + 1 evento → promoção → 2 WJA, 2 promovidas', async () => {
    const w = await makeAlmostCompleteWorker('a1');
    const v1 = await makeVacancy();
    const v2 = await makeVacancy();
    const b1 = await seedBlocked(w, v1);
    const b2 = await seedBlocked(w, v2);

    // Antes: nas 2 vagas o card é o BLOQUEADO, em INICIADO.
    for (const [v, b] of [[v1, b1], [v2, b2]] as const) {
      const antes = cardsOf(await funnel(v), w);
      expect(antes.map((c) => [c.col, c.id, c.isBlocked])).toEqual([['INICIADO', b, true]]);
    }

    // O caminho do ADMIN (não o do wizard) completa o cadastro.
    await new UpdateWorkerProfileFieldsUseCase().execute(
      { workerId: w, profession: 'AT' },
      { source: 'admin_panel', actorUid: 'staff-uid-043' },
    );

    const { rows: st } = await pool.query(`SELECT status FROM workers WHERE id = $1`, [w]);
    expect(st[0].status).toBe('REGISTERED');
    const { rows: ev } = await pool.query(
      `SELECT id FROM domain_events WHERE event = 'worker.registration_completed' AND payload->>'workerId' = $1`,
      [w],
    );
    expect(ev).toHaveLength(1);

    // O Pub/Sub não existe no teste: o handler do evento é chamado direto, com o payload da linha gravada.
    await createPromoteBlockedApplicationsHandler(pool)({ workerId: w }, { eventId: ev[0].id });

    const { rows: promo } = await pool.query(
      `SELECT id, promoted_at, promoted_wja_id FROM worker_blocked_applications WHERE worker_id = $1 ORDER BY id`,
      [w],
    );
    expect(promo).toHaveLength(2);
    expect(promo.every((r) => r.promoted_at !== null && r.promoted_wja_id !== null)).toBe(true);

    for (const v of [v1, v2]) {
      const depois = cardsOf(await funnel(v), w);
      expect(depois).toHaveLength(1);
      expect(depois[0].col).toBe('INICIADO');
      expect(depois[0].isBlocked ?? false).toBe(false); // card normal, não o bloqueado
    }
  });
});

describe('A1 só promove — edição do admin NÃO rebaixa REGISTERED legado fora do critério', () => {
  it('REGISTERED sem documentos/área (fora do critério do recálculo) + admin edita um campo → segue REGISTERED, sem evento novo', async () => {
    const w = await makeRegisteredWorker('a1-legado'); // INSERT já REGISTERED: o trigger só barra a transição PARA REGISTERED
    const eventosAntes = await pool.query(`SELECT count(*)::int AS n FROM domain_events WHERE payload->>'workerId' = $1`, [w]);
    const histAntes = await pool.query(`SELECT count(*)::int AS n FROM worker_status_history WHERE worker_id = $1`, [w]);

    const r = await new UpdateWorkerProfileFieldsUseCase().execute(
      { workerId: w, profession: 'AT' },
      { source: 'admin_panel', actorUid: 'staff-uid-043' },
    );

    expect(r.fieldsUpdated).toEqual(['profession']);
    const { rows } = await pool.query(`SELECT status, profession FROM workers WHERE id = $1`, [w]);
    expect(rows[0]).toEqual({ status: 'REGISTERED', profession: 'AT' });
    const eventosDepois = await pool.query(`SELECT count(*)::int AS n FROM domain_events WHERE payload->>'workerId' = $1`, [w]);
    const histDepois = await pool.query(`SELECT count(*)::int AS n FROM worker_status_history WHERE worker_id = $1`, [w]);
    // o único evento permitido é o mirror da própria edição (já existia antes do A1); nenhum de status
    expect(histDepois.rows[0].n).toBe(histAntes.rows[0].n);
    expect(eventosDepois.rows[0].n - eventosAntes.rows[0].n).toBe(1);
    const { rows: ev } = await pool.query(`SELECT event FROM domain_events WHERE payload->>'workerId' = $1`, [w]);
    expect(ev.map((e) => e.event)).toEqual(['worker.mirror_requested']);
  });
});

describe('A2 — a varredura automática não revive tentativa DISPENSADA', () => {
  it('dispensada + cadastro completo → skip `dismissed`, sem WJA, e o card segue em REJECTED', async () => {
    const w = await makeRegisteredWorker('a2');
    const v = await makeVacancy();
    const b = await seedBlocked(w, v, true);

    const result = await new PromoteBlockedApplicationsUseCase(pool).execute(w);

    expect(result).toEqual({ promoted: 0, skipped: 1, reasons: { dismissed: 1 } });
    const { rows } = await pool.query(`SELECT promoted_at FROM worker_blocked_applications WHERE id = $1`, [b]);
    expect(rows[0].promoted_at).toBeNull();
    const { rows: wja } = await pool.query(
      `SELECT 1 FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [w, v],
    );
    expect(wja).toHaveLength(0);
    const cards = cardsOf(await funnel(v), w);
    expect(cards.map((c) => [c.col, c.id, c.isBlocked, c.isDismissed])).toEqual([['REJECTED', b, true, true]]);
  });

  it('a tentativa ativa do MESMO worker em outra vaga continua promovendo (só a dispensada fica)', async () => {
    const w = await makeRegisteredWorker('a2-mix');
    const vDisp = await makeVacancy();
    const vAtiva = await makeVacancy();
    await seedBlocked(w, vDisp, true);
    await seedBlocked(w, vAtiva);

    const result = await new PromoteBlockedApplicationsUseCase(pool).execute(w);

    expect(result).toEqual({ promoted: 1, skipped: 1, reasons: { dismissed: 1 } });
  });
});

describe('A4 — worker com 2+ áreas de atendimento não duplica o card', () => {
  it('2 áreas + WJA na vaga → 1 card; o total do Kanban = counts.columns da funnel-table', async () => {
    const wDuas = await makeRegisteredWorker('a4-duas');
    const wUma = await makeRegisteredWorker('a4-uma');
    const v = await makeVacancy();
    for (const [w, zona] of [[wDuas, 'Palermo'], [wDuas, 'Belgrano'], [wUma, 'Recoleta']] as const) {
      await pool.query(
        `INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, work_zone, address_line)
         VALUES ($1, -34.57, -58.42, 10, $2, 'Av X 1')`,
        [w, zona],
      );
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, messaged_at)
         SELECT $1, $2, 'INVITED', 'manual', NOW() WHERE NOT EXISTS
           (SELECT 1 FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2)`,
        [w, v],
      );
    }

    const stages = await funnel(v);
    expect(cardsOf(stages, wDuas).map((c) => c.col)).toEqual(['INICIADO']); // 1 card só
    expect(cardsOf(stages, wUma)).toHaveLength(1);

    const totalKanban = Object.values(stages).reduce((n, cs) => n + cs.length, 0);
    const { counts } = await new GetFunnelTableUseCase().execute(v);
    const totalTabela = Object.values(counts.columns ?? {}).reduce((n: number, x) => n + Number(x), 0);
    expect(totalKanban).toBe(2);
    expect(totalTabela).toBe(totalKanban);
  });

  it('a área escolhida é determinística: a mais antiga', async () => {
    const w = await makeRegisteredWorker('a4-det');
    const v = await makeVacancy();
    await pool.query(
      `INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, work_zone, address_line, created_at)
       VALUES ($1, -34.5, -58.4, 10, 'Nova', 'Av Y 2', NOW()),
              ($1, -34.5, -58.4, 10, 'Antiga', 'Av Z 3', NOW() - INTERVAL '30 days')`,
      [w],
    );
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, messaged_at)
       VALUES ($1, $2, 'INVITED', 'manual', NOW())`,
      [w, v],
    );
    const card = cardsOf(await funnel(v), w) as Array<Card & { workZone?: string }>;
    expect(card).toHaveLength(1);
    expect(card[0].workZone).toBe('Antiga');
  });
});
