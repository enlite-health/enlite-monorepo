/**
 * case-title-caso-en.e2e.test.ts — spec 028 (caso-en-em-todo-lugar), passo 3.1.
 *
 * D422 (24/09/2026, substitui o ponto 6 da D412): o WRITE PATH do título de
 * vacante passa a formatar o número — "CASO EN{n}-{m}" para caso nativo
 * (case_number ≥1000, sequence própria, migration 459), "CASO {n}-{m}" para
 * legado do ClickUp (<1000, congelado). Postgres REAL, API REAL — sem mock.
 *
 * Molde: `patient-native-case-number.e2e.test.ts` (fixture de paciente + pool
 * real), `vacancies-api.test.ts` (POST /api/admin/vacancies com campos
 * mínimos — `case_number` no body não precisa bater com o `case_number` do
 * paciente; o controller não valida essa consistência), `talentum-prescreening.test.ts`
 * Parte 2 (webhook HTTP, USE_MOCK_AUTH bypassa X-Partner-Key — ver
 * `PartnerAuthMiddleware.requirePartnerKey`).
 *
 * Cobre:
 *   (a) caso nativo → título grava "CASO EN{n}-{m}"
 *   (b) caso legado → título grava "CASO {n}-{m}", sem prefixo
 *   (c) parseCaseTitleReference(title) do (a) devolve caseNumber e ordinal(=vacancy_number)
 *   (d) pré-triagem (webhook Talentum) resolve job_posting_id com o título novo
 *   (e) migration 472 reescreve título existente (backup em title_before_en) e é idempotente
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';
import { parseCaseTitleReference } from '../../src/shared/utils/parseCaseTitleReference';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MIGRATION_472_SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations', '472_job_postings_title_caso_en.sql'),
  'utf8',
);

describe('CASO EN em todo lugar — título de vacante, parser e pré-triagem (spec 028, passo 3.1)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  const createdVacancyIds: string[] = [];

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'caso-en-028-e2e',
      email: 'caso-en-028@e2e.local',
      role: 'admin',
    });
    patientId = await createPatientFixture(pool, 'caso-en-028');
  });

  afterAll(async () => {
    if (createdVacancyIds.length > 0) {
      await pool.query('DELETE FROM job_postings WHERE id = ANY($1::uuid[])', [createdVacancyIds]);
    }
    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
    await pool.query('DELETE FROM users WHERE firebase_uid = $1', ['caso-en-028-e2e']);
    await pool.end();
  });

  // ── (a)/(b)/(c) — write path + parser lendo de volta ──────────────────────

  describe('POST /api/admin/vacancies — título grava o número formatado (D422)', () => {
    it('(a) caso nativo (case_number=94041, ≥1000) → title = "CASO EN94041-{vacancy_number}"; parser lê caseNumber e ordinal=vacancy_number', async () => {
      const caseNumber = 94041;
      const res = await api.post(
        '/api/admin/vacancies',
        {
          patient_id: patientId,
          case_number: caseNumber,
          worker_profile_sought: 'AT com experiência em adultos mayores',
          schedule_days_hours: 'Lunes a Viernes 08-16hs',
          providers_needed: 1,
        },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(201);
      createdVacancyIds.push(res.data.data.id);

      const { rows } = await pool.query<{ title: string; vacancy_number: number; case_number: number }>(
        'SELECT title, vacancy_number, case_number FROM job_postings WHERE id = $1',
        [res.data.data.id],
      );
      expect(rows).toHaveLength(1);
      const { title, vacancy_number } = rows[0];
      expect(title).toBe(`CASO EN${caseNumber}-${vacancy_number}`);

      // (c) parser compartilhado lê o título de volta — SUP-1: ordinal carrega vacancy_number.
      const parsed = parseCaseTitleReference(title);
      expect(parsed.caseNumber).toBe(caseNumber);
      expect(parsed.ordinal).toBe(vacancy_number);
    });

    it('(b) caso legado (case_number=811, <1000) → title = "CASO 811-{vacancy_number}", sem prefixo (D412 inalterado)', async () => {
      const caseNumber = 811;
      const res = await api.post(
        '/api/admin/vacancies',
        {
          patient_id: patientId,
          case_number: caseNumber,
          worker_profile_sought: 'AT com experiência em adultos mayores',
          schedule_days_hours: 'Lunes a Viernes 08-16hs',
          providers_needed: 1,
        },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(201);
      createdVacancyIds.push(res.data.data.id);

      const { rows } = await pool.query<{ title: string; vacancy_number: number }>(
        'SELECT title, vacancy_number FROM job_postings WHERE id = $1',
        [res.data.data.id],
      );
      const { title, vacancy_number } = rows[0];
      expect(title).toBe(`CASO ${caseNumber}-${vacancy_number}`);
      expect(title).not.toContain('EN');

      const parsed = parseCaseTitleReference(title);
      expect(parsed.caseNumber).toBe(caseNumber);
      expect(parsed.ordinal).toBe(vacancy_number);
    });
  });

  // ── (d) — pré-triagem resolve job_posting_id com o título novo ────────────

  describe('POST /api/webhooks/talentum/prescreening — pré-triagem resolve o job_posting com título "CASO EN…" (achado #6 fechado)', () => {
    it('nome do caso Talentum "CASO EN94041-{m}, AT, Zona Norte" encontra o job_posting nativo criado em (a)', async () => {
      const caseNumber = 94042; // dedicado a este teste — evita depender de ordem entre `it`s
      const createRes = await api.post(
        '/api/admin/vacancies',
        {
          patient_id: patientId,
          case_number: caseNumber,
          worker_profile_sought: 'AT',
          providers_needed: 1,
        },
        authHeaders(adminToken),
      );
      expect(createRes.status).toBe(201);
      const vacancyId = createRes.data.data.id as string;
      createdVacancyIds.push(vacancyId);

      const { rows } = await pool.query<{ title: string }>(
        'SELECT title FROM job_postings WHERE id = $1',
        [vacancyId],
      );
      const realTitle = rows[0].title; // "CASO EN94042-{m}"
      expect(realTitle).toContain('EN94042');

      const webhookRes = await api.post(
        '/api/webhooks/talentum/prescreening',
        envelope({
          prescreening: { id: 'e2e-028-psc-caso-en', name: `${realTitle}, AT, para pacientes con Depresión (F32) - Zona Norte` },
        }),
      );

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.data.resolved.jobPosting).toBe(true);
      expect(webhookRes.data.jobPostingId).toBe(vacancyId);
    });
  });

  // ── (e) — migration 472 reescreve título existente e é idempotente ────────

  describe('migration 472 — reescreve título de caso nativo existente para "CASO EN{n}-{m}", com backup e idempotência', () => {
    // O `api` do docker-compose.test.yml já roda `run-migrations-docker.js`
    // (todas as migrations, incluindo a 472) NO BOOT do container, ANTES
    // deste describe existir — então quando o teste roda, a 472 já foi
    // aplicada uma vez contra o banco (na época, vazio de linhas próprias
    // deste teste). Para provar a REESCRITA em cima de dados, semeamos as
    // linhas AQUI (depois do boot) e reaplicamos o SQL do arquivo da
    // migration diretamente via `pool.query` (2ª opção do passo 3.1: "rode
    // o SQL do arquivo via pool") — `ALTER TABLE ... ADD COLUMN IF NOT
    // EXISTS` é idempotente (coluna já existe, no-op), e o `UPDATE` acha as
    // linhas recém-semeadas porque `title_before_en IS NULL` para elas.
    let nativeId: string;
    let legacyId: string;

    beforeAll(async () => {
      const nativeIns = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, description, status, case_number)
         VALUES ('CASO 1234-1', 'seed migration 472 (spec 028, e2e-028)', 'SEARCHING', 1234)
         RETURNING id`,
      );
      nativeId = nativeIns.rows[0].id;

      const legacyIns = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, description, status, case_number)
         VALUES ('CASO 500-2', 'seed migration 472 (spec 028, e2e-028)', 'SEARCHING', 500)
         RETURNING id`,
      );
      legacyId = legacyIns.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM job_postings WHERE id = ANY($1::uuid[])', [[nativeId, legacyId]]);
    });

    it('nativa (case_number=1234) vira "CASO EN1234-1" com title_before_en="CASO 1234-1"; legada (500) fica intocada', async () => {
      await pool.query(MIGRATION_472_SQL);

      const { rows } = await pool.query<{ id: string; title: string; title_before_en: string | null }>(
        'SELECT id, title, title_before_en FROM job_postings WHERE id = ANY($1::uuid[])',
        [[nativeId, legacyId]],
      );
      const native = rows.find((r) => r.id === nativeId)!;
      const legacy = rows.find((r) => r.id === legacyId)!;

      expect(native.title).toBe('CASO EN1234-1');
      expect(native.title_before_en).toBe('CASO 1234-1');

      expect(legacy.title).toBe('CASO 500-2');
      expect(legacy.title_before_en).toBeNull();
    });

    it('reexecução é idempotente — 2ª corrida não muda a linha já reescrita', async () => {
      await pool.query(MIGRATION_472_SQL); // já rodou 1x no teste anterior; roda de novo

      const { rows } = await pool.query<{ title: string; title_before_en: string | null }>(
        'SELECT title, title_before_en FROM job_postings WHERE id = $1',
        [nativeId],
      );
      expect(rows[0].title).toBe('CASO EN1234-1');
      expect(rows[0].title_before_en).toBe('CASO 1234-1');
    });
  });
});
