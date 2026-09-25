/**
 * vacancy-locked-fields.integration.e2e.ts @integration — fase 1,
 * `openspec/changes/completar-vacante-em-rascunho/fase-1.md`.
 *
 * Backend real (Docker `enlite-api`, rebuildada desta worktree) + Postgres real. Zero mock de
 * API. Só dado sintético. Auth por token mock (`USE_MOCK_AUTH=true` no backend de teste — mesmo
 * caminho de `vacancy-dates.integration.e2e.ts`), sem browser: é um contrato de API, não de tela.
 *
 * Cobre F3: paciente + serviço contratado (API) → dispara o foguete
 * (`POST .../activate-recruitment`, o endpoint que o botão "Lançar" usa) → a vaga nasce com
 * `contracted_service_id` → `GET` devolve `locked_fields` (os 8 campos que vieram do serviço) →
 * `PUT` num campo travado (`schedule`) recusa com 422 e o banco não muda → `PUT` num campo livre
 * (`required_professions`) aceita e persiste.
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';

const BACKEND_URL = process.env.API_BASE_URL || 'http://localhost:8080';

// Mock-auth token aceito pelo backend quando USE_MOCK_AUTH=true (mesmo molde de
// vacancy-dates.integration.e2e.ts) — sem Firebase emulator, sem UI.
const MOCK_ADMIN = {
  uid: 'e2e-int-admin-locked-fields',
  email: 'admin.lockedfields@e2e.test',
  role: 'admin',
};
const MOCK_TOKEN = 'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN), 'utf-8').toString('base64');
const AUTH_HEADERS = {
  Authorization: `Bearer ${MOCK_TOKEN}`,
  'Content-Type': 'application/json',
};

test.describe('vacancy-locked-fields — fase 1 (completar-vacante-em-rascunho) @integration', () => {
  test.setTimeout(60_000);

  let patientId = '';
  let addressId = '';
  let serviceId = '';
  let vacancyId = '';

  test.beforeAll(async ({ request }) => {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION',
      firstName: 'LockedFields',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      hasConsent: true,
      insuranceInformed: 'OSDE',
    });
    patientId = seeded.patientId;
    addressId = seeded.addressId ?? '';
    if (!addressId) throw new Error('insertTestPatient não devolveu addressId');

    // Serviço contratado pela API (não SQL) — é o dado que o foguete lê para preencher
    // SOURCE_LOCKED_FIELDS (F3): providers_needed, schedule, patient_address_id (via addressId).
    const svcRes = await request.post(
      `${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`,
      {
        headers: AUTH_HEADERS,
        data: {
          serviceCode: 'AT',
          providersNeeded: 1,
          weeklyHours: 20,
          careLocation: 'HOME',
          addressId,
          schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
        },
      },
    );
    expect(svcRes.ok(), `POST contracted-services falhou: ${svcRes.status()} ${await svcRes.text()}`).toBe(true);
    serviceId = (await svcRes.json()).data.id as string;

    // Dispara o foguete — o MESMO endpoint que `contracted-service-activate-recruitment-*` chama
    // no drawer (ActivateRecruitmentUseCase via AdminPatientContractedServicesController).
    const activateRes = await request.post(
      `${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
      { headers: AUTH_HEADERS },
    );
    expect(activateRes.ok(), `activate-recruitment falhou: ${activateRes.status()} ${await activateRes.text()}`).toBe(true);
    vacancyId = (await activateRes.json()).data.vacancyId as string;
  });

  test.afterAll(() => cleanupTestPatient(patientId));

  test('GET devolve locked_fields com os 8 campos travados (contracted_service_id setado pelo foguete) e updated_at presente', async ({ request }) => {
    test.skip(!vacancyId, 'foguete não criou vacancyId no beforeAll');

    const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS });
    expect(res.ok(), `GET falhou: ${res.status()} ${await res.text()}`).toBe(true);
    const body = (await res.json()).data;

    expect(body.contracted_service_id).toBe(serviceId);
    expect(new Set(body.locked_fields)).toEqual(
      new Set([
        'case_number', 'patient_id', 'patient_address_id', 'contracted_service_id',
        'age_range_min', 'age_range_max', 'schedule', 'providers_needed',
      ]),
    );
    expect(body.locked_fields).toHaveLength(8);
    expect(body.updated_at).toBeTruthy();
  });

  test('PUT em campo travado (schedule) → 422 com locked_fields e o banco não muda; PUT em campo livre (required_professions) → 200 e persiste', async ({ request }) => {
    test.skip(!vacancyId, 'foguete não criou vacancyId no beforeAll');

    // `locked_fields` do GET — a comparação abaixo é contra ELE, na mesma execução, não contra
    // uma lista escrita neste arquivo (fase-1.md, "Termina quando" #3).
    const getRes = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS });
    const lockedFromGet: string[] = (await getRes.json()).data.locked_fields;

    const scheduleBefore = runSQL(`SELECT schedule::text FROM job_postings WHERE id='${vacancyId}'`);

    const putLocked = await request.put(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, {
      headers: AUTH_HEADERS,
      data: { schedule: [{ dayOfWeek: 3, startTime: '09:00', endTime: '13:00' }] },
    });
    expect(putLocked.status()).toBe(422);
    const putLockedBody = await putLocked.json();
    expect(putLockedBody.locked_fields).toEqual(['schedule']);
    expect(lockedFromGet).toEqual(expect.arrayContaining(putLockedBody.locked_fields));

    const scheduleAfter = runSQL(`SELECT schedule::text FROM job_postings WHERE id='${vacancyId}'`);
    expect(scheduleAfter).toBe(scheduleBefore);

    const putFree = await request.put(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, {
      headers: AUTH_HEADERS,
      data: { required_professions: ['AT'] },
    });
    expect(putFree.ok(), `PUT campo livre falhou: ${putFree.status()} ${await putFree.text()}`).toBe(true);

    const professionsAfter = runSQL(`SELECT required_professions::text FROM job_postings WHERE id='${vacancyId}'`);
    expect(professionsAfter).toBe('{AT}');
  });
});
