/**
 * vacancy-address-versioning.e2e.test.ts
 *
 * Full end-to-end flow that covers the scenario reported by the operator:
 *
 *   1. Patient created via ClickUp sync with address "Av A".
 *   2. Vacancy 1 created via admin API → points to the patient_addresses row.
 *   3. Operator updates the address in ClickUp to "Av B" → sync runs again.
 *   4. Vacancy 2 created via admin API → must point to the NEW address.
 *
 * The migration 198 versioning rule guarantees:
 *   - Vacancy 1 still shows "Av A" (preserved row, archived_at filled).
 *   - Vacancy 2 shows "Av B" (new row, active).
 *   - GET /api/admin/patients/:id/addresses lists only "Av B" (archived filtered).
 *
 * The flow uses the real sync engine (SyncPatientFromClickUpTaskUseCase,
 * in-memory task — no HTTP) + the real admin API (axios, mock token) + the
 * real Postgres DB.
 *
 * Documented in: docs/features/vacancy-creation/10-bug-historico-endereco-antigo.md
 *
 * ── 11/09/2026 — decisão de remoção do sync automático ClickUp ──────────────
 * Chamava `ClickUpPatientWebhookController` via supertest + HMAC + fetch
 * mockado. O webhook foi removido — a plataforma é a fonte, carga do ClickUp
 * só pontual/manual. Este teste passou a chamar
 * `SyncPatientFromClickUpTaskUseCase.execute()` diretamente: MESMO motor,
 * mesma regra de versionamento de endereço, sem o transporte HTTP/HMAC que só
 * o webhook precisava.
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
import {
  PatientService,
  PatientSourceLabelRepository,
  PatientInsuranceVerifiedRepository,
  PatientDeviceTypeRepository,
} from '../../src/modules/case';
import { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { SyncPatientFromClickUpTaskUseCase, type SyncPatientResult } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const PATIENT_LIST_ID = '901304883903';
const DATABASE_URL    =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TASK_PREFIX = 'cu-e2e-versioning-';

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
    name:   `Caso ${caseNumber}, Paciente Versioning`,
    status: { status: 'activo', color: '#00c800', type: 'custom' },
    parent: null,
    url:    `https://app.clickup.com/t/${taskId}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
    list:   { id: PATIENT_LIST_ID, name: 'Estado de Pacientes' },
    custom_fields: [
      { id: 'cf-nombre',    name: 'Nombre de Paciente',                type: 'text',     value: 'Paciente' },
      { id: 'cf-apellido',  name: 'Apellido del Paciente',             type: 'text',     value: `Caso ${caseNumber}` },
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

function makeStubResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: () => null,
    resolveLabel:    () => null,
    resolveLabels:   () => [],
    // Task 1.11: o catálogo diz que os campos EXISTEM (é o que este stub quer dizer com
    // "resolves nothing"); `null` aqui significaria campo renomeado/apagado e o mapper
    // recusaria a task inteira, de propósito.
    getFieldType:    () => 'drop_down',
    dropdownFieldNames: [],
    labelsFieldNames:   [],
    getDropdownOptions: () => ({}),
    getLabelsOptions:   () => ({}),
  } as unknown as ClickUpFieldResolver;
}

/** Mesmas deps que `ClickUpPatientWebhookController.create()` montava — sem o
 *  refresher de catálogo (defesa específica de processo webhook de vida longa;
 *  este motor roda uma vez por chamada, catálogo sempre fresco). */
function makeUseCase(): SyncPatientFromClickUpTaskUseCase {
  const resolver = makeStubResolver();
  return new SyncPatientFromClickUpTaskUseCase({
    mapper:                new ClickUpPatientMapper(resolver),
    patientService:        new PatientService(),
    sourceLabelRepository: new PatientSourceLabelRepository(),
    insuranceRepository:   new PatientInsuranceVerifiedRepository(),
    deviceTypeRepository:  new PatientDeviceTypeRepository(),
  });
}

async function syncTask(
  useCase: SyncPatientFromClickUpTaskUseCase,
  task: ClickUpTask,
): Promise<SyncPatientResult> {
  return useCase.execute(task, { onMissingContact: 'flag' });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Vacancy address versioning — full flow (ClickUp → vacancy 1 → update → vacancy 2)', () => {
  const api = createApiClient();
  let pool: Pool;
  let useCase: SyncPatientFromClickUpTaskUseCase;
  let adminToken: string;
  let createdVacancyIds: string[] = [];

  beforeAll(async () => {
    pool    = new Pool({ connectionString: DATABASE_URL });
    useCase = makeUseCase();
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid:   'versioning-admin',
      email: 'versioning-admin@e2e.local',
      role:  'admin',
    });
  });

  afterAll(async () => {
    // Clean vacancies first (FK to patient_addresses)
    if (createdVacancyIds.length > 0) {
      await pool
        .query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [createdVacancyIds])
        .catch(() => {});
    }
    // Clean patients + cascade addresses
    await pool
      .query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`])
      .catch(() => {});
    await pool.end();
  });

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  it('preserves address on vacancy 1, links vacancy 2 to the new address', async () => {
    const taskId      = `${TASK_PREFIX}primary`;
    const caseNumber  = 920001;

    // ── 1) Sync creates patient with "Av A, Villa Ballester" ────────────────
    const initialLocation = locationField(
      'Av A 100, Villa Ballester, Buenos Aires, Argentina',
      [
        { long_name: 'Buenos Aires',  short_name: 'BA',  types: ['administrative_area_level_1', 'political'] },
        { long_name: 'Villa Ballester', short_name: 'VB', types: ['locality', 'political'] },
      ],
      -34.55, -58.55,
    );

    const initialTask = makeClickUpTask(taskId, caseNumber, initialLocation, 'Av A 100');
    const syncResult1 = await syncTask(useCase, initialTask);
    expect(syncResult1.kind).toBe('CREATED');

    const patientRow = await pool.query<{ id: string }>(
      `SELECT id FROM patients WHERE clickup_task_id = $1`,
      [taskId],
    );
    expect(patientRow.rows).toHaveLength(1);
    const patientId = patientRow.rows[0].id;

    const addrInitial = await pool.query<{ id: string; address_formatted: string; archived_at: string | null }>(
      `SELECT id, address_formatted, archived_at FROM patient_addresses
        WHERE patient_id = $1`,
      [patientId],
    );
    expect(addrInitial.rows).toHaveLength(1);
    expect(addrInitial.rows[0].address_formatted).toBe('Av A 100, Villa Ballester, Buenos Aires, Argentina');
    expect(addrInitial.rows[0].archived_at).toBeNull();
    const oldAddressId = addrInitial.rows[0].id;

    // ── 2) Vacancy 1 created via admin API ──────────────────────────────────
    const vac1Res = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         caseNumber,
        patient_id:          patientId,
        patient_address_id:  oldAddressId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status: 'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(vac1Res.status).toBe(201);
    const vacancy1Id = vac1Res.data.data.id as string;
    createdVacancyIds.push(vacancy1Id);

    // Simulate Talentum publish so vacancy 1 holds an address snapshot. New
    // hybrid semantics: ClickUp sync preserves addresses on published
    // vacancies (is_draft=false) and remaps drafts to the refreshed row.
    await pool.query(`UPDATE job_postings SET is_draft = false WHERE id = $1`, [vacancy1Id]);

    // ── 3) Sync updates patient with new address "Av B, CABA" ───────────────
    const newLocation = locationField(
      'Av B 999, CABA, Argentina',
      [
        { long_name: 'Ciudad Autónoma de Buenos Aires', short_name: 'CABA',        types: ['administrative_area_level_1', 'political'] },
        { long_name: 'Buenos Aires',                    short_name: 'Buenos Aires', types: ['locality', 'political'] },
        { long_name: 'Constitución',                    short_name: 'Constitución', types: ['sublocality_level_1', 'political'] },
      ],
      -34.62, -58.39,
    );
    const updateTask  = makeClickUpTask(taskId, caseNumber, newLocation, 'Av B 999');
    const syncResult2 = await syncTask(useCase, updateTask);
    expect(syncResult2.kind).toBe('UPDATED');

    // Old address row: still in DB, NOW with archived_at set
    const oldAddrAfter = await pool.query<{ archived_at: string | null }>(
      `SELECT archived_at FROM patient_addresses WHERE id = $1`,
      [oldAddressId],
    );
    expect(oldAddrAfter.rows[0].archived_at).not.toBeNull();

    // New address row: created in same slot, active
    const activeAddrs = await pool.query<{ id: string; address_formatted: string; display_order: number; archived_at: string | null }>(
      `SELECT id, address_formatted, display_order, archived_at
         FROM patient_addresses
        WHERE patient_id = $1
          AND archived_at IS NULL`,
      [patientId],
    );
    expect(activeAddrs.rows).toHaveLength(1);
    expect(activeAddrs.rows[0].address_formatted).toBe('Av B 999, CABA, Argentina');
    expect(activeAddrs.rows[0].display_order).toBe(1);
    const newAddressId = activeAddrs.rows[0].id;
    expect(newAddressId).not.toBe(oldAddressId);

    // ── 4) GET /api/admin/patients/:id/addresses returns only the new ───────
    const listRes = await api.get(`/api/admin/patients/${patientId}/addresses`, auth());
    expect(listRes.status).toBe(200);
    expect(listRes.data.data).toHaveLength(1);
    expect(listRes.data.data[0].id).toBe(newAddressId);
    expect(listRes.data.data[0].address_formatted).toBe('Av B 999, CABA, Argentina');

    // ── 5) Vacancy 2 created via admin API → points to NEW address ──────────
    const vac2Res = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         caseNumber,
        patient_id:          patientId,
        patient_address_id:  newAddressId,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule: [{ dayOfWeek: 1, startTime: '14:00', endTime: '18:00' }],
        status: 'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(vac2Res.status).toBe(201);
    const vacancy2Id = vac2Res.data.data.id as string;
    createdVacancyIds.push(vacancy2Id);

    // ── 6) Vacancy 1 preserves the OLD address (via JOIN with archived row) ─
    const vac1Detail = await api.get(`/api/admin/vacancies/${vacancy1Id}`, auth());
    expect(vac1Detail.status).toBe(200);
    expect(vac1Detail.data.data.patient_address_id).toBe(oldAddressId);
    expect(vac1Detail.data.data.patient_address_formatted).toBe('Av A 100, Villa Ballester, Buenos Aires, Argentina');

    // Vacancy 2 carries the NEW address
    const vac2Detail = await api.get(`/api/admin/vacancies/${vacancy2Id}`, auth());
    expect(vac2Detail.status).toBe(200);
    expect(vac2Detail.data.data.patient_address_id).toBe(newAddressId);
    expect(vac2Detail.data.data.patient_address_formatted).toBe('Av B 999, CABA, Argentina');

    // ── 7) Attempting to bind a NEW vacancy to the ARCHIVED address fails ───
    const rejectRes = await api
      .post(
        '/api/admin/vacancies',
        {
          case_number:         caseNumber,
          patient_id:          patientId,
          patient_address_id:  oldAddressId, // archived
          required_professions: ['AT'],
          providers_needed:    1,
          schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
          status: 'PENDING_ACTIVATION',
        },
        auth(),
      )
      .catch((err) => err.response);
    expect(rejectRes.status).toBe(400);
    expect(rejectRes.data.error).toMatch(/arquivado/);

    // ── 8) by-address endpoint surfaces existing vacancies ──────────────────
    // Vacancy 1 (archived address) — listed because its FK still points to it
    const byOldRes = await api.get(
      `/api/admin/vacancies/by-address?patient_address_id=${oldAddressId}`,
      auth(),
    );
    expect(byOldRes.status).toBe(200);
    const oldHits = byOldRes.data.data as Array<{ id: string }>;
    expect(oldHits.map((v) => v.id)).toContain(vacancy1Id);

    // Vacancy 2 (current address) — listed
    const byNewRes = await api.get(
      `/api/admin/vacancies/by-address?patient_address_id=${newAddressId}`,
      auth(),
    );
    expect(byNewRes.status).toBe(200);
    const newHits = byNewRes.data.data as Array<{ id: string }>;
    expect(newHits.map((v) => v.id)).toContain(vacancy2Id);
  });

  it('paciente com 2 endereços ativos: operador pode escolher qualquer um', async () => {
    const taskId      = `${TASK_PREFIX}two-addrs`;
    const caseNumber  = 920002;

    // Patient created with 2 simultaneous addresses (slot 1 + slot 2) ──────────
    const taskTwo = makeClickUpTask(
      taskId,
      caseNumber,
      locationField('Slot1 Prim 10, Buenos Aires', [
        { long_name: 'Buenos Aires', short_name: 'BA', types: ['administrative_area_level_1', 'political'] },
      ]),
      'Slot1 Prim 10',
    );
    // Inject a second active slot directly into the fixture so the mapper
    // produces 2 patient_addresses rows on the first sync.
    taskTwo.custom_fields = taskTwo.custom_fields.map((cf) => {
      if (cf.name === 'Domicilio 2 Principal Paciente') {
        return {
          ...cf,
          value: locationField('Slot2 Sec 20, Buenos Aires', [
            { long_name: 'Buenos Aires', short_name: 'BA', types: ['administrative_area_level_1', 'political'] },
          ]),
        };
      }
      if (cf.name === 'Domicilio Informado Paciente 2') {
        return { ...cf, value: 'Slot2 Sec 20' };
      }
      return cf;
    });

    const syncResult = await syncTask(useCase, taskTwo);
    expect(syncResult.kind).toBe('CREATED');

    const patientRow = await pool.query<{ id: string }>(
      `SELECT id FROM patients WHERE clickup_task_id = $1`,
      [taskId],
    );
    const patientId = patientRow.rows[0].id;

    // GET /addresses lists both
    const listRes = await api.get(`/api/admin/patients/${patientId}/addresses`, auth());
    expect(listRes.status).toBe(200);
    const addrs = listRes.data.data as Array<{ id: string; display_order: number }>;
    expect(addrs).toHaveLength(2);
    const slot1 = addrs.find((a) => a.display_order === 1)!;
    const slot2 = addrs.find((a) => a.display_order === 2)!;
    expect(slot1).toBeTruthy();
    expect(slot2).toBeTruthy();

    // Operator picks slot 2 — vacancy is created and points to slot 2
    const vacRes = await api.post(
      '/api/admin/vacancies',
      {
        case_number:         caseNumber,
        patient_id:          patientId,
        patient_address_id:  slot2.id,
        required_professions: ['AT'],
        providers_needed:    1,
        schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '17:00' }],
        status: 'PENDING_ACTIVATION',
      },
      auth(),
    );
    expect(vacRes.status).toBe(201);
    createdVacancyIds.push(vacRes.data.data.id as string);
    expect(vacRes.data.data.patient_address_id).toBe(slot2.id);
  });
});
