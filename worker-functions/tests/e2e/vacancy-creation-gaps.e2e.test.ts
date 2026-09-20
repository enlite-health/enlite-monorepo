/**
 * vacancy-creation-gaps.e2e.test.ts
 *
 * Empirical validation of the 5 gaps detected in the 2026-05-27 review of
 * `docs/features/vacancy-creation/`. See memory `vacancy-creation-open-issues`.
 *
 * Each test asserts the DESIRED behaviour, not the current code behaviour. So
 * a failing test here CONFIRMS the gap is real; a passing test means either
 * the gap was already fixed or the analysis was wrong.
 *
 * Gaps covered:
 *   - Gap 1: `updateVacancy` uses `status === 'PENDING_ACTIVATION'` instead of
 *     `is_draft` to decide if wide edits are allowed.
 *   - Gap 2a: `updateVacancy` does NOT validate `archived_at IS NULL` for the
 *     new `patient_address_id`.
 *   - Gap 2b: `updateVacancy` does NOT validate ownership (same patient) for
 *     the new `patient_address_id`.
 *   - Gap 3: `deleteVacancy` only flips status='CLOSED'; the resulting draft
 *     row keeps `is_draft=true` and `deleted_at=NULL`, so it remains visible
 *     in `GET /api/admin/vacancies/in-progress`.
 *   - Gap 4: ClickUp sync Path 1 (UPDATE in-place when address_formatted is
 *     unchanged) propagates state/city/neighborhood/lat/lng to vacancies that
 *     already point to that address row. Doc 03 says "frozen"; doc 06 says
 *     "refresh acceptable" — these tests document actual behaviour so we can
 *     decide.
 *
 * Gap #5 (doc text inconsistencies in 04-estados-status.md and
 * 09-edicao-e-restricoes.md) is not E2E-testable.
 *
 * ── 11/09/2026 — decisão de remoção do sync automático ClickUp ──────────────
 * O Gap 4 originalmente disparava o sync via `ClickUpPatientWebhookController`
 * real (supertest + HMAC + fetch mockado). O webhook foi removido (decisão do
 * Gabriel: a plataforma é a fonte, carga do ClickUp só pontual/manual). Este
 * arquivo passou a chamar `SyncPatientFromClickUpTaskUseCase.execute()`
 * diretamente — MESMO motor, mesma regra de versionamento de endereço, sem o
 * transporte HTTP/HMAC que só o webhook precisava. Gaps 1/2a/2b/3 não usam
 * ClickUp — seguem inalterados.
 */

// ── Mocks must come before any module imports ────────────────────────────────

jest.mock('firebase-functions', () => ({
  logger: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { Pool } from 'pg';
import { SyncPatientFromClickUpTaskUseCase } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';
import { makeUseCase, syncTask } from './helpers/clickupSyncEngine';

const PATIENT_LIST_ID = '901304883903';
const DATABASE_URL    =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TASK_PREFIX = 'cu-e2e-gaps-';

function locationField(
  formattedAddress: string,
  addressComponents?: Array<{ long_name: string; short_name: string; types: string[] }>,
  lat = -34.6,
  lng = -58.4,
) {
  return {
    formatted_address: formattedAddress,
    lat,
    lng,
    ...(addressComponents ? { address_components: addressComponents } : {}),
  };
}

function makeClickUpTask(
  taskId: string,
  caseNumber: number,
  primaryLocation: ReturnType<typeof locationField>,
  primaryRaw: string,
): ClickUpTask {
  return {
    id:     taskId,
    name:   `Caso ${caseNumber}, Paciente Gap-Test`,
    status: { status: 'activo', color: '#00c800', type: 'custom' },
    parent: null,
    url:    `https://app.clickup.com/t/${taskId}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
    list:   { id: PATIENT_LIST_ID, name: 'Estado de Pacientes' },
    custom_fields: [
      { id: 'cf-nombre',    name: 'Nombre de Paciente',                type: 'text',     value: 'Paciente' },
      { id: 'cf-apellido',  name: 'Apellido del Paciente',             type: 'text',     value: `Gap ${caseNumber}` },
      { id: 'cf-caso',      name: 'Caso Número',                       type: 'number',   value: caseNumber },
      { id: 'cf-dom1',      name: 'Domicilio 1 Principal Paciente',    type: 'location', value: primaryLocation },
      { id: 'cf-raw1',      name: 'Domicilio Informado Paciente 1',    type: 'text',     value: primaryRaw },
      { id: 'cf-dom2',      name: 'Domicilio 2 Principal Paciente',    type: 'location', value: null },
      { id: 'cf-raw2',      name: 'Domicilio Informado Paciente 2',    type: 'text',     value: null },
      { id: 'cf-dom3',      name: 'Domicilio 3 Principal Paciente',    type: 'location', value: null },
      { id: 'cf-raw3',      name: 'Domicilio Informado Paciente 3',    type: 'text',     value: null },
    ],
  } as unknown as ClickUpTask;
}

async function insertActiveAddress(
  pool: Pool,
  patientId: string,
  formatted: string,
  displayOrder = 1,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO patient_addresses (patient_id, display_order, address_formatted, source)
     VALUES ($1, $2, $3, 'admin_manual')
     RETURNING id`,
    [patientId, displayOrder, formatted],
  );
  return rows[0].id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Vacancy creation gaps — review 2026-05-27', () => {
  const api = createApiClient();
  let pool: Pool;
  let useCase: SyncPatientFromClickUpTaskUseCase;
  let adminToken: string;
  const trackedVacancies: string[] = [];
  const trackedPatients: string[] = [];

  beforeAll(async () => {
    pool    = new Pool({ connectionString: DATABASE_URL });
    useCase = makeUseCase();
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid:   'gaps-admin',
      email: 'gaps-admin@e2e.local',
      role:  'admin',
    });
  });

  afterAll(async () => {
    if (trackedVacancies.length > 0) {
      await pool
        .query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [trackedVacancies])
        .catch(() => {});
    }
    if (trackedPatients.length > 0) {
      await pool
        .query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [trackedPatients])
        .catch(() => {});
    }
    await pool
      .query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`])
      .catch(() => {});
    await pool.end();
  });

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  // ─── Gap 1 ────────────────────────────────────────────────────────────────

  it('Gap 1: vaga is_draft=true + status=SEARCHING permite edit amplo via PUT', async () => {
    const patientId = await createPatientFixture(pool, 'gap1');
    trackedPatients.push(patientId);
    const addressId = await insertActiveAddress(pool, patientId, 'Av Gap1 100, Buenos Aires, Argentina');

    // Frontend default sends status='SEARCHING' on Step 1 submit. is_draft is
    // left to its DB default (true) — only PublishVacancyToTalentumUseCase
    // flips it.
    const createRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99001,
        patient_id:          patientId,
        patient_address_id:  addressId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'SEARCHING',
      },
      auth(),
    );
    expect(createRes.status).toBe(201);
    const vacancyId = createRes.data.data.id as string;
    trackedVacancies.push(vacancyId);

    // Confirm the state we expect to provoke the bug
    const { rows } = await pool.query<{ is_draft: boolean; status: string }>(
      `SELECT is_draft, status FROM job_postings WHERE id = $1`,
      [vacancyId],
    );
    expect(rows[0].is_draft).toBe(true);
    expect(rows[0].status).toBe('SEARCHING');

    // Wide edit: change required_professions (NOT in OPERATIONAL_EDITABLE_FIELDS).
    // Per migration 168, while is_draft=true the operator should still be able
    // to edit any field. Today's controller checks status==='PENDING_ACTIVATION'
    // — so this PUT should return 403 (confirming the gap) until the fix uses
    // is_draft.
    const editRes = await api.put(
      `/api/admin/vacancies/${vacancyId}`,
      { required_professions: ['CAREGIVER'] },
      auth(),
    );
    expect(editRes.status).toBe(200);
    expect(editRes.data.data.required_professions).toEqual(['CAREGIVER']);
  });

  // ─── Gap 2a + 2b ──────────────────────────────────────────────────────────

  it('Gap 2a: PUT com patient_address_id arquivado retorna 400', async () => {
    const patientId = await createPatientFixture(pool, 'gap2a');
    trackedPatients.push(patientId);
    const addrId    = await insertActiveAddress(pool, patientId, 'Av Gap2a 100, BA');

    const createRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99002,
        patient_id:          patientId,
        patient_address_id:  addrId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(createRes.status).toBe(201);
    const vacancyId = createRes.data.data.id as string;
    trackedVacancies.push(vacancyId);

    // Archive the active address out-of-band (simulates webhook versioning)
    // and insert a new active row in the same slot.
    await pool.query(`UPDATE patient_addresses SET archived_at = NOW() WHERE id = $1`, [addrId]);
    await insertActiveAddress(pool, patientId, 'Av Gap2a 999, BA');

    // PUT pointing the vacancy back at the archived address: should be 400
    // (doc 09 line 86: "Edit de address arquivado é rejeitado").
    const editRes = await api.put(
      `/api/admin/vacancies/${vacancyId}`,
      { patient_address_id: addrId },
      auth(),
    );
    expect(editRes.status).toBe(400);
  });

  it('Gap 2b: PUT com patient_address_id de outro paciente retorna 400', async () => {
    const patientA = await createPatientFixture(pool, 'gap2b-a');
    const patientB = await createPatientFixture(pool, 'gap2b-b');
    trackedPatients.push(patientA, patientB);

    const addrA = await insertActiveAddress(pool, patientA, 'Av Gap2b-A, BA');
    const addrB = await insertActiveAddress(pool, patientB, 'Av Gap2b-B, BA');

    const createRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99003,
        patient_id:          patientA,
        patient_address_id:  addrA,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(createRes.status).toBe(201);
    const vacancyId = createRes.data.data.id as string;
    trackedVacancies.push(vacancyId);

    // PUT pointing the vacancy at an address that belongs to ANOTHER patient:
    // should be 400 (same ownership check the POST already enforces).
    const editRes = await api.put(
      `/api/admin/vacancies/${vacancyId}`,
      { patient_address_id: addrB },
      auth(),
    );
    expect(editRes.status).toBe(400);
  });

  // ─── Gap 3 ────────────────────────────────────────────────────────────────

  it('Gap 3: rascunho encerrado via DELETE não aparece em /vacancies/in-progress', async () => {
    const patientId = await createPatientFixture(pool, 'gap3');
    trackedPatients.push(patientId);
    const addrId    = await insertActiveAddress(pool, patientId, 'Av Gap3 100, BA');

    const createRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99004,
        patient_id:          patientId,
        patient_address_id:  addrId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(createRes.status).toBe(201);
    const vacancyId = createRes.data.data.id as string;
    trackedVacancies.push(vacancyId);

    // Sanity check: appears in /in-progress before delete
    const beforeRes = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${patientId}`,
      auth(),
    );
    expect(beforeRes.status).toBe(200);
    const beforeIds = (beforeRes.data.data as Array<{ id: string }>).map((v) => v.id);
    expect(beforeIds).toContain(vacancyId);

    // Soft-delete
    const delRes = await api.delete(`/api/admin/vacancies/${vacancyId}`, auth());
    expect(delRes.status).toBe(200);

    // After fix: deleteVacancy now sets deleted_at = NOW() in addition to
    // status = 'CLOSED'. is_draft is left untouched (the row is still a
    // draft historically — it was just discarded). The combination of
    // deleted_at IS NOT NULL is what makes the row disappear from the
    // in-progress filter.
    const { rows } = await pool.query<{ status: string; is_draft: boolean; deleted_at: string | null }>(
      `SELECT status, is_draft, deleted_at FROM job_postings WHERE id = $1`,
      [vacancyId],
    );
    expect(rows[0].status).toBe('CLOSED');
    expect(rows[0].is_draft).toBe(true);
    expect(rows[0].deleted_at).not.toBeNull();

    // The drafts list MUST NOT include a closed vacancy. Today's filter only
    // checks is_draft=true + deleted_at IS NULL + clickup_sync IS NULL — no
    // status guard. Expected: closed drafts are filtered out.
    const afterRes = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${patientId}`,
      auth(),
    );
    expect(afterRes.status).toBe(200);
    const afterIds = (afterRes.data.data as Array<{ id: string }>).map((v) => v.id);
    expect(afterIds).not.toContain(vacancyId);
  });

  // ─── Gap 4 ────────────────────────────────────────────────────────────────
  // Hybrid semantics:
  //   - Draft vacancy (is_draft=true)   → sync refresh is OK, vacancy reflects
  //     the latest address (Path 1 in-place; or remapped to new row in Path 2).
  //   - Published vacancy (is_draft=false) → sync must NEVER mutate the row it
  //     points to. Sync forces versioning (archive + insert) and the published
  //     vacancy stays anchored to the archived row.

  async function seedPatientWithAddress(taskSlug: string, caseNumber: number) {
    const taskId = `${TASK_PREFIX}${taskSlug}`;
    const oldLocation = locationField(
      `Av Gap4 ${caseNumber}, Buenos Aires, Argentina`,
      [
        { long_name: 'Buenos Aires', short_name: 'BA',           types: ['administrative_area_level_1', 'political'] },
        { long_name: 'Buenos Aires', short_name: 'Buenos Aires', types: ['locality', 'political'] },
        { long_name: 'Palermo Old',  short_name: 'Palermo Old',  types: ['sublocality_level_1', 'political'] },
      ],
    );
    const r1 = await syncTask(
      useCase,
      makeClickUpTask(taskId, caseNumber, oldLocation, `Av Gap4 ${caseNumber}`),
    );
    expect(r1.kind).toBe('CREATED');

    const { rows: pRows } = await pool.query<{ id: string }>(
      `SELECT id FROM patients WHERE clickup_task_id = $1`,
      [taskId],
    );
    const { rows: aRows } = await pool.query<{ id: string; neighborhood: string | null }>(
      `SELECT id, neighborhood FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL`,
      [pRows[0].id],
    );
    expect(aRows[0].neighborhood).toBe('Palermo Old');
    return { taskId, patientId: pRows[0].id, addrId: aRows[0].id };
  }

  async function syncWithRefreshedNeighborhood(taskId: string, caseNumber: number) {
    const refreshedLocation = locationField(
      `Av Gap4 ${caseNumber}, Buenos Aires, Argentina`,
      [
        { long_name: 'Buenos Aires', short_name: 'BA',           types: ['administrative_area_level_1', 'political'] },
        { long_name: 'Buenos Aires', short_name: 'Buenos Aires', types: ['locality', 'political'] },
        { long_name: 'Palermo New',  short_name: 'Palermo New',  types: ['sublocality_level_1', 'political'] },
      ],
    );
    const r2 = await syncTask(
      useCase,
      makeClickUpTask(taskId, caseNumber, refreshedLocation, `Av Gap4 ${caseNumber}`),
    );
    expect(r2.kind).toBe('UPDATED');
  }

  it('Gap 4a: vaga DRAFT (is_draft=true) reflete neighborhood novo após sync', async () => {
    const { taskId, patientId, addrId } = await seedPatientWithAddress('gap4a', 99005);

    const createRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99005,
        patient_id:          patientId,
        patient_address_id:  addrId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(createRes.status).toBe(201);
    const vacancyId = createRes.data.data.id as string;
    trackedVacancies.push(vacancyId);

    // Confirm vacancy is still a draft (is_draft default = true).
    const { rows: vacRows } = await pool.query<{ is_draft: boolean }>(
      `SELECT is_draft FROM job_postings WHERE id = $1`,
      [vacancyId],
    );
    expect(vacRows[0].is_draft).toBe(true);

    await syncWithRefreshedNeighborhood(taskId, 99005);

    // Path 1: same address_formatted + no published vacancy depends on it →
    // UPDATE in-place. Vacancy (still draft) reflects the new neighborhood.
    const vacDetail = await api.get(`/api/admin/vacancies/${vacancyId}`, auth());
    expect(vacDetail.status).toBe(200);
    expect(vacDetail.data.data.patient_neighborhood).toBe('Palermo New');
  });

  it('Gap 4b: vaga PUBLICADA (is_draft=false) preserva neighborhood antigo após sync', async () => {
    const { taskId, patientId, addrId } = await seedPatientWithAddress('gap4b', 99006);

    const createRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99006,
        patient_id:          patientId,
        patient_address_id:  addrId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(createRes.status).toBe(201);
    const vacancyId = createRes.data.data.id as string;
    trackedVacancies.push(vacancyId);

    // Simulate publish: is_draft = false (real publish goes through
    // PublishVacancyToTalentumUseCase, but we only need the flag state here).
    await pool.query(
      `UPDATE job_postings SET is_draft = false WHERE id = $1`,
      [vacancyId],
    );

    await syncWithRefreshedNeighborhood(taskId, 99006);

    // Sync detected a published vacancy on the row → forced Path 2 (archive +
    // insert). Published vacancy stays anchored to the archived row.
    const { rows: vacRow } = await pool.query<{ patient_address_id: string }>(
      `SELECT patient_address_id FROM job_postings WHERE id = $1`,
      [vacancyId],
    );
    expect(vacRow[0].patient_address_id).toBe(addrId);

    const { rows: addrRow } = await pool.query<{ archived_at: string | null; neighborhood: string | null }>(
      `SELECT archived_at, neighborhood FROM patient_addresses WHERE id = $1`,
      [addrId],
    );
    expect(addrRow[0].archived_at).not.toBeNull();
    expect(addrRow[0].neighborhood).toBe('Palermo Old');

    // GET vacancy reflects the snapshot — operator sees the address they
    // published with, not what the Google refresh now reports.
    const vacDetail = await api.get(`/api/admin/vacancies/${vacancyId}`, auth());
    expect(vacDetail.status).toBe(200);
    expect(vacDetail.data.data.patient_neighborhood).toBe('Palermo Old');
  });

  it('Gap 4c: paciente com vaga publicada E vaga draft — sync remappa só a draft', async () => {
    const { taskId, patientId, addrId } = await seedPatientWithAddress('gap4c', 99007);

    // Create + publish vacancy 1
    const pub = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99007,
        patient_id:          patientId,
        patient_address_id:  addrId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(pub.status).toBe(201);
    const publishedId = pub.data.data.id as string;
    trackedVacancies.push(publishedId);
    await pool.query(`UPDATE job_postings SET is_draft = false WHERE id = $1`, [publishedId]);

    // Create vacancy 2 — kept as draft
    const draft = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         99007,
        patient_id:          patientId,
        patient_address_id:  addrId,
        required_professions: ['CAREGIVER'],
        providers_needed:    1,
        schedule:            [{ dayOfWeek: 2, startTime: '10:00', endTime: '18:00' }],
        status:              'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(draft.status).toBe(201);
    const draftId = draft.data.data.id as string;
    trackedVacancies.push(draftId);

    await syncWithRefreshedNeighborhood(taskId, 99007);

    // Published vacancy: still pointing to the archived row, neighborhood='Palermo Old'
    const pubDetail = await api.get(`/api/admin/vacancies/${publishedId}`, auth());
    expect(pubDetail.data.data.patient_neighborhood).toBe('Palermo Old');
    expect(pubDetail.data.data.patient_address_id).toBe(addrId);

    // Draft vacancy: remapped to the new active row, neighborhood='Palermo New'
    const draftDetail = await api.get(`/api/admin/vacancies/${draftId}`, auth());
    expect(draftDetail.data.data.patient_neighborhood).toBe('Palermo New');
    expect(draftDetail.data.data.patient_address_id).not.toBe(addrId);
  });
});
