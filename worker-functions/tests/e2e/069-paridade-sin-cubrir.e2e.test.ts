/**
 * 069-paridade-sin-cubrir.e2e.test.ts @integration — spec 069, F2 (FR-12/FR-35, plano §5 "Paridade (i)").
 *
 * UMA semente, quatro leitores, as MESMAS contagens de "Sin cubrir":
 *   (1) GET .../itinerary/events        → ocorrências `uncovered` (turnos)
 *   (2) GET .../itinerary               → `services[].uncoveredShifts` e `alerts[]` (turnos)
 *   (3) GET .../patients/kanban/services → `uncoveredDays` (DIAS — a mesma lista, deduplicada por data)
 *   (4) a função do alerta, chamada DIRETO sobre o que o banco devolve (o caso de uso do alerta diário nasce na F4 e entra aqui)
 *
 * Semente (hoje = Buenos Aires, lido do BANCO; a janela é [hoje, hoje+6] e cada dia da semana cai nela exatamente 1×):
 *   A  dia hoje+1  faixa 08-12  titular alocado + falta SEM substituto            → uncovered (ausência)
 *   B  dia hoje+2  faixa 08-12  NINGUÉM alocado                                   → uncovered (faixa sem alocação, FR-12)
 *   C  dia hoje+3  faixa 08-10  NINGUÉM alocado          } 2 faixas no mesmo dia → 2 turnos, 1 dia
 *   D  dia hoje+3  faixa 14-16  NINGUÉM alocado          }
 *   E  dia hoje+4  faixa 08-12  titular alocado + falta COM substituto            → substituted (NÃO conta)
 *   F  dia hoje+5  faixa 08-12  titular com valid_to = hoje+5 (último dia)        → covered (NÃO conta) — o valid_to é INCLUSIVO
 *   G  dia hoje+7 (faixa que só VALE a partir de hoje+7: o mesmo dia da semana de hoje)   → NÃO conta (hoje+7 está fora da janela)
 * Esperado: 4 turnos sin cubrir (A, B, C, D) em 3 dias (hoje+1, hoje+2, hoje+3).
 */
import { Pool, type PoolClient } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedRequestForAssignment } from './helpers/seedSubstitutionRequest';
import { expandServiceOccurrences, uncoveredWindow } from '../../src/modules/case/domain/serviceOccurrences';
import { uncoveredDayAlerts, uncoveredDayCount, uncoveredShiftCount } from '../../src/modules/case/domain/itineraryAlerts';
import { readServiceOccurrenceInputs } from '../../src/modules/case/infrastructure/occurrenceInputs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `ps069p-${RUN}-`;

describe('069 · paridade de "Sin cubrir" nos 4 leitores — uma semente @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';
  let serviceId = '';
  let jobId = '';
  let hoje = '';
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  const day = async (n: number): Promise<string> => (await q<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [hoje, n]))[0].d;
  const dow = async (date: string): Promise<number> => (await q<{ w: number }>(`SELECT extract(dow FROM $1::date)::int AS w`, [date]))[0].w;

  async function mkWorker(label: string): Promise<{ workerId: string; wjaId: string }> {
    const workerId = (await q<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [`${PREFIX}${label}`, `${PREFIX}${label}@e2e.local`]))[0].id;
    const wjaId = (
      await q<{ id: string }>(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'import') RETURNING id`, [workerId, jobId])
    )[0].id;
    return { workerId, wjaId };
  }
  async function mkSlot(weekday: number, start: string, minutes: number, validFrom = '2026-01-01'): Promise<string> {
    return (
      await q<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by) VALUES ($1, $2, $3, $4, daterange($5::date, NULL), $6, $6) RETURNING id`,
        [serviceId, weekday, start, minutes, validFrom, PREFIX],
      )
    )[0].id;
  }
  async function mkAssignment(slotId: string, w: { workerId: string; wjaId: string }, validTo: string | null = null): Promise<string> {
    return (
      await q<{ id: string }>(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [slotId, w.workerId, w.wjaId, await day(-30), validTo, PREFIX],
      )
    )[0].id;
  }
  async function mkAbsence(assignmentId: string, onDate: string, substitute: { workerId: string; wjaId: string } | null): Promise<void> {
    const requestId = await seedRequestForAssignment(pool, assignmentId, { createdBy: PREFIX });
    await pool.query(
      `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by, request_id) VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [assignmentId, onDate, substitute?.workerId ?? null, substitute?.wjaId ?? null, PREFIX, requestId],
    );
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`ps069p-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    hoje = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS d`))[0].d;

    patientId = (await q<{ id: string }>(`INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Paridade', 'SinCubrir', 'AR', 'ACTIVE') RETURNING id`, [`${PREFIX}p`]))[0].id;
    const addressId = (await q<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [patientId]))[0].id;
    serviceId = (
      await q<{ id: string }>(`INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`, [patientId, addressId, PREFIX])
    )[0].id;
    jobId = (await q<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${PREFIX}vaga`, serviceId, patientId]))[0].id;

    const titular = await mkWorker('titular');
    const substituto = await mkWorker('substituto');

    const [dA, dB, dC, dE, dF, dG] = await Promise.all([1, 2, 3, 4, 5, 7].map(day));
    const slotA = await mkSlot(await dow(dA), '08:00', 240);
    await mkSlot(await dow(dB), '08:00', 240); // B: ninguém
    await mkSlot(await dow(dC), '08:00', 120); // C: ninguém
    await mkSlot(await dow(dC), '14:00', 120); // D: ninguém, mesmo dia de C
    const slotE = await mkSlot(await dow(dE), '08:00', 240);
    const slotF = await mkSlot(await dow(dF), '08:00', 240);
    await mkSlot(await dow(dG), '08:00', 240, dG); // G: só vale a partir de hoje+7 (o mesmo dia da semana de hoje): fora da janela

    const aA = await mkAssignment(slotA, titular);
    await mkAbsence(aA, dA, null);
    const aE = await mkAssignment(slotE, titular);
    await mkAbsence(aE, dE, substituto);
    await mkAssignment(slotF, titular, dF); // valid_to = o próprio dia da ocorrência (inclusivo)
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM patient_itinerary_absence ab USING patient_itinerary_assignment a, patient_itinerary_slot s WHERE ab.assignment_id = a.id AND a.slot_id = s.id AND s.contracted_service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM patient_itinerary_substitution_request WHERE contracted_service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM patient_itinerary_assignment a USING patient_itinerary_slot s WHERE a.slot_id = s.id AND s.contracted_service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobId]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  it('a mesma semente dá 4 turnos em 3 dias nos quatro leitores', async () => {
    const expectedDates = await Promise.all([1, 2, 3].map(day)); // hoje+1, +2, +3
    const { to } = uncoveredWindow(hoje);

    // (1) agenda: ocorrências uncovered da janela
    const eventsRes = await api.get(`/api/admin/patients/${patientId}/itinerary/events?from=${hoje}&to=${to}&serviceId=${serviceId}`, { headers: asAdmin.headers });
    expect(eventsRes.status).toBe(200);
    const events = eventsRes.data.data.events as Array<{ date: string; status: string; assignmentId: string | null; requestId: string | null }>;
    const uncovered = events.filter((e) => e.status === 'uncovered');
    expect(uncovered).toHaveLength(4);
    expect([...new Set(uncovered.map((e) => e.date))].sort()).toEqual(expectedDates);
    // FR-12: 3 das 4 são faixa SEM alocação (ids nulos); 1 é a falta sem substituto (com pedido)
    expect(uncovered.filter((e) => e.assignmentId === null)).toHaveLength(3);
    expect(uncovered.filter((e) => e.assignmentId !== null && e.requestId !== null)).toHaveLength(1);
    // controle positivo da semente: há também 1 substituted (E) e 1 covered (F) na janela — nem tudo é uncovered
    expect(events.filter((e) => e.status === 'substituted')).toHaveLength(1);
    expect(events.filter((e) => e.status === 'covered').length).toBeGreaterThanOrEqual(1);

    // (2) cartão do serviço: uncoveredShifts + alerts[] + horizonDays
    const itRes = await api.get(`/api/admin/patients/${patientId}/itinerary`, { headers: asAdmin.headers });
    expect(itRes.status).toBe(200);
    const it = itRes.data.data as { horizonDays: number; asOf: string; alerts: Array<{ serviceId: string; date: string }>; services: Array<{ contractedServiceId: string; uncoveredShifts: number }> };
    expect(it.asOf).toBe(hoje);
    expect(it.horizonDays).toBe(7);
    expect(it.services.find((s) => s.contractedServiceId === serviceId)?.uncoveredShifts).toBe(4);
    expect(it.alerts.filter((a) => a.serviceId === serviceId)).toHaveLength(4);
    expect([...new Set(it.alerts.map((a) => a.date))].sort()).toEqual(expectedDates);

    // (3) Kanban: uncoveredDays = DIAS (3), não turnos (4)
    const kRes = await api.get(`/api/admin/patients/kanban/services?country=AR`, { headers: asAdmin.headers });
    expect(kRes.status).toBe(200);
    const kPatient = (kRes.data.data.patients as Array<{ patientId: string; services: Array<{ contractedServiceId: string; uncoveredDays: number }> }>).find((p) => p.patientId === patientId);
    expect(kPatient?.services.find((s) => s.contractedServiceId === serviceId)?.uncoveredDays).toBe(3);

    // (4) a função do alerta, chamada DIRETO sobre as entradas lidas do banco (o caso de uso do alerta diário, F4, é um chamador a mais)
    const client: PoolClient = await pool.connect();
    try {
      const inputs = await readServiceOccurrenceInputs(client, patientId, serviceId, hoje, to);
      const alerts = uncoveredDayAlerts(expandServiceOccurrences(inputs.slots, inputs.assignments, inputs.absences, hoje, to), hoje);
      expect(uncoveredShiftCount(alerts)).toBe(4);
      expect(uncoveredDayCount(alerts)).toBe(3);
      expect([...new Set(alerts.map((a) => a.date))].sort()).toEqual(expectedDates);
    } finally {
      client.release();
    }
  });
});
