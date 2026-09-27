/**
 * patient-itinerary-slots.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 7, P9
 *
 * Prova a derivação `schedule → slots` (DX-7.5) contra a API REAL: a criação/edição do serviço
 * SEMPRE passa pela API (nunca SQL — a API é o único caminho de produção que dispara
 * `syncItinerarySlots`); o banco só é tocado para LER `patient_itinerary_slot`
 * (id/weekday/active/updated_at) e no `afterAll`. Um paciente por `it` (independentes, sem
 * `describe.serial`).
 *
 *   (a) POST com 3 faixas idênticas → dedup, 1 slot ativo (roteiro (a) do P8).
 *   (b) GET /itinerary logo depois do POST → `contratadas`/`cobertas`/`slots` (roteiro (b) do P8).
 *   (c) PATCH schedule seg→ter→seg: a reativação reusa a MESMA linha, nunca DELETE/INSERT novo
 *       (roteiro (c) do P8).
 *   + POST sem `schedule` → 0 slot.
 *   + PATCH `schedule: null` → todos os ativos ficam inativos; nenhuma linha é apagada.
 *   + PATCH de outro campo (`weeklyHours`) sem a chave `schedule` → slots intocados, `updated_at`
 *     idêntico (chave AUSENTE ≠ `schedule: null` — Merge Patch só toca o que o corpo manda).
 *   + PATCH com `schedule` fora da forma (`endTime < startTime`) → 400, slots intocados.
 *   + baixa do serviço (`active:false`) → slots intocados (baixa não é `schedule`).
 *   + GET /itinerary de paciente com 2 serviços (1 com horário, 1 sem) → os 2 aparecem; o serviço
 *     sem horário devolve `slots: []`.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pis-slots-e2e-${RUN}-`;

interface SlotRow {
  id: string;
  weekday: number;
  active: boolean;
  updated_at: Date;
}

describe('patient_itinerary_slot — derivação schedule → slots pela API real (Fase 7, P9) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`pis-slots-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // patients → patient_addresses/patient_contracted_services → patient_itinerary_slot, tudo em
    // cascata (ON DELETE CASCADE); nenhum job_posting nasce neste arquivo.
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.end();
  });

  let seedCounter = 0;

  async function seedPatient(slug: string): Promise<{ patientId: string; addressId: string }> {
    seedCounter += 1;
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Slots', 'AR', 'ADMISSION') RETURNING id`,
        [`${TASK_PREFIX}${seedCounter}-${slug}`],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
    return { patientId, addressId };
  }

  async function slotsOf(serviceId: string): Promise<SlotRow[]> {
    const r = await pool.query<SlotRow>(
      `SELECT id, weekday, active, updated_at FROM patient_itinerary_slot WHERE contracted_service_id = $1 ORDER BY weekday`,
      [serviceId],
    );
    return r.rows;
  }

  it('(a) POST com 3 faixas idênticas → dedup, 1 slot ativo', async () => {
    const { patientId, addressId } = await seedPatient('a');
    const r = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      {
        serviceCode: 'AT',
        weeklyHours: 20,
        addressId,
        schedule: [
          { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
          { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
          { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
        ],
      },
      asAdmin,
    );
    expect(r.status).toBe(201);
    const serviceId = r.data.data.id as string;
    const slots = await slotsOf(serviceId);
    expect(slots).toHaveLength(1);
    expect(slots[0].active).toBe(true);
  });

  it('(b) GET /itinerary logo depois do POST → contratadas/cobertas/slots', async () => {
    const { patientId, addressId } = await seedPatient('b');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', weeklyHours: 20, addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    expect(created.status).toBe(201);
    const serviceId = created.data.data.id as string;

    const got = await api.get(`/api/admin/patients/${patientId}/itinerary`, asAdmin);
    expect(got.status).toBe(200);
    expect(got.data.data.services).toHaveLength(1);
    const svc = got.data.data.services[0];
    expect(svc.contractedServiceId).toBe(serviceId);
    expect(svc.contratadas).toEqual({ weekly: 20, authorized: null });
    expect(svc.cobertas).toBe(0);
    expect(svc.slots).toHaveLength(1);
    expect(svc.slots[0]).toMatchObject({ weekday: 1, startTime: '08:00', endTime: '12:00', active: true, assignments: [] });
  });

  it('(c) PATCH schedule seg→ter→seg: a reativação reusa a MESMA linha', async () => {
    const { patientId, addressId } = await seedPatient('c');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    const serviceId = created.data.data.id as string;
    const before = await slotsOf(serviceId);
    expect(before).toHaveLength(1);
    const mondaySlotId = before[0].id;

    const toTuesday = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    expect(toTuesday.status).toBe(200);
    const afterFirstPatch = await slotsOf(serviceId);
    expect(afterFirstPatch).toHaveLength(2); // seg inativa + ter nova
    const mondayRow = afterFirstPatch.find((s) => s.weekday === 1)!;
    const tuesdayRow = afterFirstPatch.find((s) => s.weekday === 2)!;
    expect(mondayRow.id).toBe(mondaySlotId);
    expect(mondayRow.active).toBe(false);
    expect(tuesdayRow.active).toBe(true);

    const backToMonday = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    expect(backToMonday.status).toBe(200);
    const afterSecondPatch = await slotsOf(serviceId);
    expect(afterSecondPatch).toHaveLength(2);
    const mondayAgain = afterSecondPatch.find((s) => s.weekday === 1)!;
    const tuesdayAgain = afterSecondPatch.find((s) => s.weekday === 2)!;
    expect(mondayAgain.id).toBe(mondaySlotId); // MESMA linha, nunca DELETE/INSERT novo
    expect(mondayAgain.active).toBe(true);
    expect(tuesdayAgain.active).toBe(false);
  });

  it('POST sem `schedule` → 0 slot', async () => {
    const { patientId, addressId } = await seedPatient('sem-schedule');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', weeklyHours: 20, addressId },
      asAdmin,
    );
    expect(created.status).toBe(201);
    const serviceId = created.data.data.id as string;
    const slots = await slotsOf(serviceId);
    expect(slots).toHaveLength(0);
  });

  it('PATCH `schedule: null` → todos os ativos ficam inativos, nenhuma linha some', async () => {
    const { patientId, addressId } = await seedPatient('null');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      {
        serviceCode: 'AT',
        addressId,
        schedule: [
          { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
          { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' },
        ],
      },
      asAdmin,
    );
    const serviceId = created.data.data.id as string;
    const before = await slotsOf(serviceId);
    expect(before).toHaveLength(2);
    expect(before.every((s) => s.active)).toBe(true);

    const cleared = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { schedule: null },
      asAdmin,
    );
    expect(cleared.status).toBe(200);

    const after = await slotsOf(serviceId);
    expect(after).toHaveLength(2); // count(*) igual — nada apagado
    expect(after.every((s) => !s.active)).toBe(true);
  });

  it('PATCH de outro campo (`weeklyHours`) sem a chave `schedule` → slots intocados (updated_at igual)', async () => {
    const { patientId, addressId } = await seedPatient('outro-campo');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', weeklyHours: 10, addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    const serviceId = created.data.data.id as string;
    const before = await slotsOf(serviceId);
    expect(before).toHaveLength(1);

    const patched = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { weeklyHours: 30 },
      asAdmin,
    );
    expect(patched.status).toBe(200);
    expect(patched.data.data.weeklyHours).toBe(30);

    const after = await slotsOf(serviceId);
    expect(after).toEqual(before); // id, weekday, active E updated_at idênticos — chave ausente não chamou o sync
  });

  it('PATCH com `schedule` fora da forma (endTime < startTime) → 400, slots intocados', async () => {
    const { patientId, addressId } = await seedPatient('invalido');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    const serviceId = created.data.data.id as string;
    const before = await slotsOf(serviceId);

    const invalid = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { schedule: [{ dayOfWeek: 1, startTime: '12:00', endTime: '08:00' }] },
      asAdmin,
    );
    expect(invalid.status).toBe(400);

    const after = await slotsOf(serviceId);
    expect(after).toEqual(before);
  });

  it('baixa do serviço (active:false) → slots intocados', async () => {
    const { patientId, addressId } = await seedPatient('baixa');
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    const serviceId = created.data.data.id as string;
    const before = await slotsOf(serviceId);
    expect(before).toHaveLength(1);

    const off = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { active: false },
      asAdmin,
    );
    expect(off.status).toBe(200);
    expect(off.data.data.active).toBe(false);

    const after = await slotsOf(serviceId);
    expect(after).toEqual(before);
  });

  it('GET /itinerary com 2 serviços (1 com horário, 1 sem) → os 2 aparecem; o sem horário devolve slots: []', async () => {
    const { patientId, addressId } = await seedPatient('dois-servicos');
    const withSchedule = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, weeklyHours: 20, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] },
      asAdmin,
    );
    const withoutSchedule = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'NURSE', addressId, weeklyHours: 15 },
      asAdmin,
    );
    expect(withSchedule.status).toBe(201);
    expect(withoutSchedule.status).toBe(201);
    const withScheduleId = withSchedule.data.data.id as string;
    const withoutScheduleId = withoutSchedule.data.data.id as string;

    const got = await api.get(`/api/admin/patients/${patientId}/itinerary`, asAdmin);
    expect(got.status).toBe(200);
    expect(got.data.data.services).toHaveLength(2);

    const svcWith = got.data.data.services.find((s: { contractedServiceId: string }) => s.contractedServiceId === withScheduleId);
    const svcWithout = got.data.data.services.find((s: { contractedServiceId: string }) => s.contractedServiceId === withoutScheduleId);
    expect(svcWith.slots).toHaveLength(1);
    expect(svcWithout.slots).toEqual([]);
  });
});
