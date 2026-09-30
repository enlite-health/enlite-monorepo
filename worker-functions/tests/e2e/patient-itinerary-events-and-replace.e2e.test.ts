/**
 * patient-itinerary-events-and-replace.e2e.test.ts @integration — D445.3/D445.5.
 *
 * Prova, contra a API REAL de pé (não mock) + Postgres real: o novo GET
 * `/patients/:id/itinerary/events` (a expansão faixa × data, com ausência/substituto
 * sobreposta) e o novo POST `.../allocations/:allocationId/replace` (reemplazo permanente, 1
 * transação). O `allocate`/`registerAbsence`/`replace` passam SEMPRE pela API HTTP real
 * (`staffAuth`); só a semente de worker/vaga/candidatura/slot é SQL direto (o mesmo padrão de
 * `patient-itinerary-overlap.e2e.test.ts`).
 *
 * Datas: nunca do relógio do runner — sempre "a próxima segunda-feira" calculada NO BANCO
 * (`nextWeekday`, molde `patient-itinerary-absence.e2e.test.ts`), porque `asOf`/`operationDateOf`
 * é sempre a data de operação do PAÍS, lida pela API a partir de `now()`.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pier-e2e-${RUN}-`;

interface EventView {
  date: string;
  weekday: number;
  status: 'covered' | 'substituted' | 'uncovered';
  workerId: string | null;
  titularWorkerId: string;
  substituteWorkerId: string | null;
  absenceId: string | null;
}

describe('GET .../itinerary/events e POST .../allocations/:id/replace — API real (D445.3/D445.5) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;

  let patientId = '';
  let addressId = '';
  let serviceId = '';
  let jobId = '';
  let slotId = '';
  let nextMonday = '';
  let secondMonday = '';

  const workerIds: string[] = [];

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`pier-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'EventosReplace', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p1`],
      )
    ).rows[0].id;

    addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientId],
      )
    ).rows[0].id;

    serviceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, TASK_PREFIX],
      )
    ).rows[0].id;

    jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${TASK_PREFIX}vaga`, serviceId, patientId],
      )
    ).rows[0].id;

    // Próxima segunda-feira (weekday=1) a partir de HOJE, calculada NO BANCO — nunca `new Date()`
    // do runner (molde `patient-itinerary-absence.e2e.test.ts:nextWeekday`).
    const r = await pool.query<{ next: string }>(
      `SELECT to_char(min(g)::date, 'YYYY-MM-DD') AS next
         FROM generate_series(
           (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + 1,
           (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + 7,
           interval '1 day'
         ) g
        WHERE extract(dow FROM g) = 1`,
    );
    nextMonday = r.rows[0].next;
    // A segunda seguinte — +7 dias, sempre por `Date.UTC` (nunca `new Date()` implícito/local).
    const [y, m, d] = nextMonday.split('-').map(Number);
    secondMonday = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);

    slotId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '08:00', '12:00', $2, $2) RETURNING id`,
        [serviceId, TASK_PREFIX],
      )
    ).rows[0].id;

    await mkSelectedWorker('titular');
    await mkSelectedWorker('substituto');
    await mkSelectedWorker('novoTitular');
    await mkSelectedWorker('conflitante');
    await mkSelectedWorker('titularAlvo');
  });

  afterAll(async () => {
    // A mesma ordem de `patient-itinerary-overlap.e2e.test.ts`: alocação → job_postings (RESTRICT
    // contra `patients`) → pacientes (cascata para endereço/serviço/slot) → workers.
    // `created_by` das alocações é o ATOR da API (`staffAuth`), não `TASK_PREFIX` — ao contrário do
    // molde que insere direto por SQL; por isso o filtro é pelo SERVIÇO (via slot), não por autor.
    // `patient_itinerary_absence.assignment_id` é `ON DELETE CASCADE` (migration 484) — apagar a
    // alocação já leva a ausência junto, sem passo à parte.
    // O registro de trocas (494) referencia alocação/ausência/prestador sem cascata e é append-only para
    // a app — o dono do banco o apaga ANTES (Fase 2).
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id = $1`, [serviceId]);
    await pool.query(
      `DELETE FROM patient_itinerary_assignment a
         USING patient_itinerary_slot s
        WHERE a.slot_id = s.id AND s.contracted_service_id = $1`,
      [serviceId],
    );
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobId]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.end();
  });

  async function mkSelectedWorker(label: string): Promise<string> {
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}${label}`, `${TASK_PREFIX}${label}@e2e.local`],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'import')`,
      [workerId, jobId],
    );
    workerIds.push(workerId);
    return workerId;
  }

  function workerIdOf(label: 'titular' | 'substituto' | 'novoTitular' | 'conflitante' | 'titularAlvo'): string {
    const idx = { titular: 0, substituto: 1, novoTitular: 2, conflitante: 3, titularAlvo: 4 }[label];
    return workerIds[idx];
  }

  it('feliz: allocate pela API real → GET events mostra covered; registrar ausência com substituto → substituted', async () => {
    const titular = workerIdOf('titular');
    const allocRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/allocations`,
      { workerId: titular },
      { headers: asAdmin.headers },
    );
    expect(allocRes.status).toBe(201);
    const allocationId = allocRes.data.data.allocationId as string;

    const eventsRes = await api.get(
      `/api/admin/patients/${patientId}/itinerary/events?from=${nextMonday}&to=${nextMonday}`,
      { headers: asAdmin.headers },
    );
    expect(eventsRes.status).toBe(200);
    const events = eventsRes.data.data.events as EventView[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ date: nextMonday, weekday: 1, status: 'covered', workerId: titular, titularWorkerId: titular, absenceId: null });

    const substituto = workerIdOf('substituto');
    const absenceRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/absences`,
      { date: nextMonday, substituteWorkerId: substituto, reasonCategory: 'OTHER' },
      { headers: asAdmin.headers },
    );
    expect(absenceRes.status).toBe(201);

    // Fase 2 (C4/C9): a substituição de um dia deixou 1 registro ABSENCE com o motivo e a ausência ligada.
    const changesRes = await api.get(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/changes`,
      { headers: asAdmin.headers },
    );
    expect(changesRes.status).toBe(200);
    const changes = changesRes.data.data.changes as Array<{ kind: string; reasonCode: string; reasonLabel: string | null; outgoingWorkerId: string; incomingWorkerId: string | null; effectiveDate: string }>;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'ABSENCE', reasonCode: 'OTHER', reasonLabel: 'Otro', outgoingWorkerId: titular, incomingWorkerId: substituto, effectiveDate: nextMonday });

    const eventsAfterAbsence = await api.get(
      `/api/admin/patients/${patientId}/itinerary/events?from=${nextMonday}&to=${nextMonday}`,
      { headers: asAdmin.headers },
    );
    const substitutedEvent = (eventsAfterAbsence.data.data.events as EventView[])[0];
    expect(substitutedEvent.status).toBe('substituted');
    expect(substitutedEvent.workerId).toBe(substituto);
    expect(substitutedEvent.substituteWorkerId).toBe(substituto);
    expect(substitutedEvent.absenceId).not.toBeNull();

    // cancela a ausência — volta a covered pelo titular.
    const cancelRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/absences/${substitutedEvent.absenceId}/cancel`,
      {},
      { headers: asAdmin.headers },
    );
    expect(cancelRes.status).toBe(200);
    const eventsAfterCancel = await api.get(
      `/api/admin/patients/${patientId}/itinerary/events?from=${nextMonday}&to=${nextMonday}`,
      { headers: asAdmin.headers },
    );
    expect((eventsAfterCancel.data.data.events as EventView[])[0].status).toBe('covered');
  });

  it('Fase 2: registrar ausência SEM motivo → 422 REASON_REQUIRED; motivo inexistente → 422 REASON_INVALID; 0 linhas novas em ausência e em registro', async () => {
    const titular = workerIdOf('titular');
    const slotSemMotivo = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '17:00', '18:00', $2, $2) RETURNING id`,
        [serviceId, TASK_PREFIX],
      )
    ).rows[0].id;
    const allocRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotSemMotivo}/allocations`,
      { workerId: titular },
      { headers: asAdmin.headers },
    );
    expect(allocRes.status).toBe(201);
    const allocationId = allocRes.data.data.allocationId as string;

    const contar = async () =>
      (
        await pool.query<{ absences: number; logs: number }>(
          `SELECT (SELECT count(*)::int FROM patient_itinerary_absence WHERE assignment_id = $1) AS absences,
                  (SELECT count(*)::int FROM patient_itinerary_change_log WHERE contracted_service_id = $2) AS logs`,
          [allocationId, serviceId],
        )
      ).rows[0];
    const antes = await contar();
    const url = `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/absences`;

    const semMotivo = await api.post(url, { date: nextMonday }, { headers: asAdmin.headers });
    expect(semMotivo.status).toBe(422);
    expect(semMotivo.data.code).toBe('REASON_REQUIRED');

    const inexistente = await api.post(url, { date: nextMonday, reasonCategory: 'MOTIVO_QUE_NAO_EXISTE' }, { headers: asAdmin.headers });
    expect(inexistente.status).toBe(422);
    expect(inexistente.data.code).toBe('REASON_INVALID');

    expect(await contar()).toEqual(antes);
  });

  it('alternativo 1: intervalo maior que 62 dias → 400 ITINERARY_EVENTS_RANGE_INVALID', async () => {
    const to = new Date(`${nextMonday}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 63);
    const toStr = to.toISOString().slice(0, 10);
    const res = await api.get(`/api/admin/patients/${patientId}/itinerary/events?from=${nextMonday}&to=${toStr}`, {
      headers: asAdmin.headers,
    });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('ITINERARY_EVENTS_RANGE_INVALID');
  });

  it('reemplazo permanente: encerra o titular em D-1 e cria o novo a partir de D; GET events reflete os dois lados', async () => {
    // Novo slot dedicado (não reusa o allocationId da 1ª it, que a essa altura pode já ter mudado).
    const slot2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '14:00', '16:00', $2, $2) RETURNING id`,
        [serviceId, TASK_PREFIX],
      )
    ).rows[0].id;

    const titular = workerIdOf('titular');
    const allocRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slot2}/allocations`,
      { workerId: titular },
      { headers: asAdmin.headers },
    );
    expect(allocRes.status).toBe(201);
    const allocationId = allocRes.data.data.allocationId as string;

    // Foto ANTES do reemplazo (hoje < D): agenda, horas cobertas e estado do paciente.
    interface ItineraryView {
      asOf: string;
      services: { contractedServiceId: string; cobertas: number; slots: { id: string; assignments: { workerId: string; status: string; validFrom: string; validTo: string | null }[] }[] }[];
    }
    const snapshot = async () => {
      const itin = await api.get(`/api/admin/patients/${patientId}/itinerary`, { headers: asAdmin.headers });
      expect(itin.status).toBe(200);
      const view = itin.data.data as ItineraryView;
      const svc = view.services.find((x) => x.contractedServiceId === serviceId)!;
      const status = (await pool.query<{ status: string }>(`SELECT status FROM patients WHERE id = $1`, [patientId])).rows[0].status;
      return { view, svc, cobertas: svc.cobertas, status };
    };
    const antes = await snapshot();

    const novoTitular = workerIdOf('novoTitular');
    const replaceRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/replace`,
      { newWorkerId: novoTitular, fromDate: secondMonday },
      { headers: asAdmin.headers },
    );
    expect(replaceRes.status).toBe(200);
    expect(replaceRes.data.data.newWorkerId).toBe(novoTitular);

    // HOJE (< D) nada muda: o titular segue VIGENTE na agenda (ACTIVE, valid_to = D-1), as horas
    // cobertas e o estado do paciente são os MESMOS de antes do reemplazo.
    const depois = await snapshot();
    const slotDepois = depois.svc.slots.find((sl) => sl.id === slot2)!;
    const linhaTitular = slotDepois.assignments.find((a) => a.workerId === titular)!;
    expect(linhaTitular.status).toBe('ACTIVE'); // NÃO 'ENDED' — o defeito anterior
    const dMenos1 = new Date(Date.UTC(Number(secondMonday.slice(0, 4)), Number(secondMonday.slice(5, 7)) - 1, Number(secondMonday.slice(8, 10)) - 1)).toISOString().slice(0, 10);
    expect(linhaTitular.validTo).toBe(dMenos1);
    expect(linhaTitular.validFrom <= depois.view.asOf && depois.view.asOf <= linhaTitular.validTo!).toBe(true); // vigente HOJE
    expect(depois.cobertas).toBe(antes.cobertas);
    expect(depois.status).toBe(antes.status);
    // e o novo entra na agenda como ACTIVE desde D (não vigente hoje).
    const linhaNovo = slotDepois.assignments.find((a) => a.workerId === novoTitular)!;
    expect(linhaNovo.status).toBe('ACTIVE');
    expect(linhaNovo.validFrom).toBe(secondMonday);
    expect(linhaNovo.validTo).toBeNull();

    // Antes de D (nextMonday): ainda o titular original.
    const beforeD = await api.get(`/api/admin/patients/${patientId}/itinerary/events?from=${nextMonday}&to=${nextMonday}`, {
      headers: asAdmin.headers,
    });
    const eventoAntes = (beforeD.data.data.events as EventView[]).find((e) => e.titularWorkerId === titular);
    expect(eventoAntes?.workerId).toBe(titular);

    // A partir de D (secondMonday): o novo titular.
    const atD = await api.get(`/api/admin/patients/${patientId}/itinerary/events?from=${secondMonday}&to=${secondMonday}`, {
      headers: asAdmin.headers,
    });
    const eventoDepois = (atD.data.data.events as EventView[]).find((e) => e.titularWorkerId === novoTitular);
    expect(eventoDepois?.workerId).toBe(novoTitular);
    expect(eventoDepois?.status).toBe('covered');
  });

  it('alternativo 2: reemplazo com conflito de horário → recusado (409), e nada muda', async () => {
    // 3º slot, MESMO horário/endereço do 1º (para colidir de propósito com o conflitante).
    const slotConflito = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '09:00', '11:00', $2, $2) RETURNING id`,
        [serviceId, TASK_PREFIX],
      )
    ).rows[0].id;
    const slotAlvo = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '10:00', '12:00', $2, $2) RETURNING id`,
        [serviceId, TASK_PREFIX],
      )
    ).rows[0].id;

    const conflitante = workerIdOf('conflitante');
    const titularAlvo = workerIdOf('titularAlvo');

    // O conflitante já cobre `slotConflito` (mesmo endereço — o MESMO serviço, então mesmo address_id).
    const allocConflitante = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotConflito}/allocations`,
      { workerId: conflitante },
      { headers: asAdmin.headers },
    );
    expect(allocConflitante.status).toBe(201);

    // `titularAlvo` cobre `slotAlvo` (horário que se sobrepõe a `slotConflito`) — worker DEDICADO
    // a esta regra, para não colidir com a alocação de `titular` deixada ACTIVE pela 1ª `it`.
    const allocAlvo = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotAlvo}/allocations`,
      { workerId: titularAlvo },
      { headers: asAdmin.headers },
    );
    expect(allocAlvo.status).toBe(201);
    const allocationIdAlvo = allocAlvo.data.data.allocationId as string;

    const replaceRes = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationIdAlvo}/replace`,
      { newWorkerId: conflitante, fromDate: nextMonday },
      { headers: asAdmin.headers },
    );
    expect(replaceRes.status).toBe(409);
    expect(replaceRes.data.code).toBe('ITINERARY_OVERLAP');

    // Nada mudou: o titularAlvo original ainda cobre `slotAlvo` em `nextMonday`.
    const itinerarioDepois = await api.get(`/api/admin/patients/${patientId}/itinerary`, { headers: asAdmin.headers });
    const service = itinerarioDepois.data.data.services.find((s: { contractedServiceId: string }) => s.contractedServiceId === serviceId);
    const slotAlvoView = service.slots.find((s: { id: string }) => s.id === slotAlvo);
    const vigente = slotAlvoView.assignments.find((a: { status: string }) => a.status === 'ACTIVE');
    expect(vigente.workerId).toBe(titularAlvo);
  });
});
