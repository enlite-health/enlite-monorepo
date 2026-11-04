/**
 * 069-rotina-diaria.e2e.test.ts @integration — spec 069, F4 (T409/T411): a rotina diária, pelo ENDPOINT interno real
 * (`POST /api/internal/itinerary/daily`, X-Internal-Secret), banco real. Derivação do estado → alerta "Sin cubrir".
 *
 * TESTE NUNCA TOCA CANAL REAL: o e-mail é do `EmailService` real, que recusa envio em `NODE_ENV=test` (a API do compose roda assim, com
 * `SENDGRID_API_KEY=""` e `api.sendgrid.com` bloqueado por extra_hosts); destinatários são `qa.*@enlite.test`. O teste prova: todo despacho
 * fica `SKIPPED_TEST` (nenhum `SENT`), a chamada em processo conta 0 chamadas ao SDK (`sgMail.send` espiado) e o controle positivo mostra
 * que o espião SERIA acionado se o guard não existisse.
 *
 * Roteiro (um dia, fatos acumulados — a ordem importa):
 *  (a) paciente AR ACTIVE, montado, titular com valid_to = ontem → 1ª chamada → SEARCHING (aceite §4)  [ANTES de existir qualquer destinatário
 *      de teste: o dia dos destinatários ainda não foi gasto]
 *  (d)(e) BR: um paciente COBERTO e um com turno só em hoje+7 → o destinatário só-BR não recebe NADA (nem notificação, nem despacho)
 *  (b)(f) 3 pacientes AR descobertos × 2 destinatários AR + 1 BR descoberto → 2 notificações e 2 despachos SKIPPED_TEST, cada payload com os 3
 *      itens (ids e números, sem nome); o paciente BR fica FORA dos AR; o AR em ON_HOLD (montado) fica FORA de todos (universo P13)
 *  (c) 2ª chamada no dia → nada novo (a PK do despacho)
 *  (g) `itinerary_daily_run` terminado com `failures = 0` nos dois países
 */
import axios from 'axios';
import { Pool } from 'pg';
import { garantirCelula, grupoComCelulas, limparIamFixtures, TENANT_E2E } from './helpers/permissionFamilyHarness';

const mockSgSend = jest.fn();
jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: { send: (...a: unknown[]) => mockSgSend(...a), setApiKey: jest.fn() },
}));

import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { UncoveredShiftsAlertUseCase } from '../../src/modules/case/application/UncoveredShiftsAlertUseCase';
import { EmailChannelUnavailableError, EmailService } from '../../src/modules/identity/infrastructure/EmailService';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const DAILY = `${API_URL}/api/internal/itinerary/daily`;
const RUN = Date.now();
const PREFIX = `ps069r-${RUN}-`;

type Payload = { operationDate: string; items: Array<{ patientId: string; serviceId: string; shifts: number; firstDate: string }> };

describe('069 · rotina diária do itinerário: derivação → alerta "Sin cubrir" (HTTP real, banco real) @integration', () => {
  let pool: Pool;
  let hoje = '';
  let weekdayHoje = 0;
  let criouCelula = false;
  const U = { ra: `${PREFIX}ra`, rb: `${PREFIX}rb`, rbr: `${PREFIX}rbr` };
  const EMAIL = (uid: string) => `qa.${uid}@enlite.test`;
  const GRUPOS = { ar: `${PREFIX}g-ar`, br: `${PREFIX}g-br` };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  const daily = async (headers: Record<string, string> = { 'X-Internal-Secret': SECRET }) => axios.post(DAILY, null, { headers, validateStatus: () => true });
  const day = async (n: number): Promise<string> => (await q<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [hoje, n]))[0].d;

  async function mkPatient(label: string, country: 'AR' | 'BR', status: string): Promise<{ patientId: string; serviceId: string }> {
    const patientId = (
      await q<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed) VALUES ($1, $2, 'Rotina', $3, $4, true, 'OSDE') RETURNING id`,
        [`${PREFIX}${label}`, `Pac${label}`, country, status],
      )
    )[0].id;
    const addressId = (await q<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, $2, -34.6, -58.4) RETURNING id`, [patientId, country]))[0].id;
    const serviceId = (
      await q<{ id: string }>(`INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, $3, $4, $4) RETURNING id`, [patientId, addressId, country, PREFIX])
    )[0].id;
    return { patientId, serviceId };
  }
  const assemble = async (patientId: string, country: string) =>
    pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, $3)`, [patientId, PREFIX, country]);
  const mkVacancy = async (patientId: string, serviceId: string, country: string) =>
    q<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, $4) RETURNING id`, [`${PREFIX}vaga-${serviceId}`, serviceId, patientId, country]).then((r) => r[0].id);
  async function mkSlot(serviceId: string, validFrom = '2026-01-01', minutes = 240): Promise<string> {
    return (
      await q<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by) VALUES ($1, $2, '08:00', $3, daterange($4::date, NULL), $5, $5) RETURNING id`,
        [serviceId, weekdayHoje, minutes, validFrom, PREFIX],
      )
    )[0].id;
  }
  async function mkAssignment(slotId: string, jobId: string, country: string, tag: string, validTo: string | null): Promise<void> {
    const workerId = (await q<{ id: string }>(`INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, $3, 'REGISTERED', 'AT') RETURNING id`, [`${PREFIX}w-${tag}`, `${PREFIX}w-${tag}@e2e.local`, country]))[0].id;
    const appId = (await q<{ id: string }>(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'manual') RETURNING id`, [workerId, jobId]))[0].id;
    await pool.query(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6)`,
      [slotId, workerId, appId, await day(-30), validTo, PREFIX],
    );
  }
  async function mkRecipient(uid: string, grupo: string, countries: string[]): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES ($1, $2, $3, 'admin', 'ACTIVE', true, $4)`,
      [uid, EMAIL(uid), `QA ${uid}`, TENANT_E2E],
    );
    const groupId = await grupoComCelulas(pool, { nome: grupo, uid, celulas: [['patient_itinerary', 'update']] });
    for (const c of countries) {
      await pool.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, $2, $3, 'e2e 069 rotina')`, [groupId, c, uid]);
    }
  }
  const payloadsDe = async (uid: string): Promise<Payload[]> =>
    (await q<{ payload: Payload }>(
      `SELECT e.payload FROM notifications n JOIN notification_events e ON e.id = n.event_id WHERE n.recipient_uid = $1 AND e.type_code = 'ITINERARY_UNCOVERED_SHIFTS' ORDER BY n.created_at`,
      [uid],
    )).map((r) => r.payload);
  const despachosDe = async (uid: string) =>
    q<{ email_status: string; operation_date: string; email_error_code: string | null }>(
      `SELECT email_status, to_char(operation_date, 'YYYY-MM-DD') AS operation_date, email_error_code FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid = $1`,
      [uid],
    );
  const statusDe = async (patientId: string) => (await q<{ status: string }>(`SELECT status FROM patients WHERE id = $1`, [patientId]))[0].status;

  async function limparTudo(): Promise<void> {
    const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
    const uids = Object.values(U);
    await pool.query(`DELETE FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid = ANY($1)`, [uids]);
    await pool.query(`DELETE FROM notification_events WHERE id IN (SELECT event_id FROM notifications WHERE recipient_uid = ANY($1))`, [uids]);
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id IN (SELECT s.id FROM patient_itinerary_slot s JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id WHERE pcs.patient_id IN (${pats}))`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (${pats})`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id IN (${pats}))`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`, [Object.values(GRUPOS)]);
    await limparIamFixtures(pool, { uids, grupos: Object.values(GRUPOS) });
  }

  let paId = '';
  let p1 = '';
  let p2 = '';
  let p3 = '';
  let zId = '';
  let xId = '';
  let yId = '';
  let holdId = '';
  let s1 = '';
  let s2 = '';
  let s3 = '';
  let sZ = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    hoje = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS d`))[0].d;
    weekdayHoje = (await q<{ w: number }>(`SELECT extract(dow FROM $1::date)::int AS w`, [hoje]))[0].w;
    criouCelula = (await garantirCelula(pool, { resource: 'patient_itinerary', action: 'update', category: 'Pacientes' })).criada;
    // determinismo: a execução do dia (país × data) é de quem rodar primeiro; este arquivo parte do zero
    await pool.query(`DELETE FROM itinerary_daily_run WHERE operation_date = $1::date`, [hoje]);
  });

  afterAll(async () => {
    try {
      await limparTudo();
      if (criouCelula) await pool.query(`DELETE FROM iam.permissions WHERE resource = 'patient_itinerary' AND action = 'update'`);
      const left = await q<{ p: number; n: number }>(
        `SELECT (SELECT count(*)::int FROM patients WHERE clickup_task_id LIKE $1) AS p,
                (SELECT count(*)::int FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid LIKE $1) AS n`,
        [`${PREFIX}%`],
      );
      expect(left[0]).toEqual({ p: 0, n: 0 });
    } finally {
      await pool.end();
      await DatabaseConnection.getInstance().getPool().end(); // o pool do caso de uso em processo (T411)
    }
  });

  it('sem o segredo interno → 403 e nada roda', async () => {
    const r = await daily({});
    expect(r.status).toBe(403);
    expect(await q(`SELECT 1 FROM itinerary_daily_run WHERE operation_date = $1::date`, [hoje])).toHaveLength(0);
  });

  it('1ª chamada — (a) titular único com valid_to = ontem, paciente ACTIVE → Búsqueda; (d)(e) o destinatário só-BR não recebe nada (BR coberto e BR só em hoje+7)', async () => {
    // (a) AR, ACTIVE, montado, vaga viva, 1 faixa de 10 h com o ÚNICO titular encerrado ontem
    const pa = await mkPatient('a', 'AR', 'ACTIVE');
    paId = pa.patientId;
    const jobA = await mkVacancy(pa.patientId, pa.serviceId, 'AR');
    await mkAssignment(await mkSlot(pa.serviceId, '2026-01-01', 600), jobA, 'AR', 'a', await day(-1));
    await assemble(pa.patientId, 'AR');
    expect(await statusDe(paId)).toBe('ACTIVE');

    // (d) BR coberto hoje (titular vigente, sem fim); (e) BR cuja única faixa só VALE a partir de hoje+7
    const x = await mkPatient('x', 'BR', 'ACTIVE');
    xId = x.patientId;
    await mkAssignment(await mkSlot(x.serviceId), await mkVacancy(x.patientId, x.serviceId, 'BR'), 'BR', 'x', null);
    await assemble(xId, 'BR');
    const y = await mkPatient('y', 'BR', 'ACTIVE');
    yId = y.patientId;
    await mkSlot(y.serviceId, await day(7));
    await assemble(yId, 'BR');
    await mkRecipient(U.rbr, GRUPOS.br, ['BR']);

    const r = await daily();
    expect(r.status).toBe(200);
    expect(r.data).toEqual(expect.objectContaining({ failures: 0 }));
    expect(r.data.patientsChecked).toBeGreaterThanOrEqual(3);

    // (a) aceite §4: ACTIVE → SEARCHING pela rotina, registrado como mudança do SISTEMA
    expect(await statusDe(paId)).toBe('SEARCHING');
    const hist = await q<{ old_value: string; new_value: string; change_source: string }>(`SELECT old_value, new_value, change_source FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`, [paId]);
    expect(hist[0]).toMatchObject({ old_value: 'ACTIVE', new_value: 'SEARCHING' });
    expect(String(hist[0].change_source)).toMatch(/system/i);
    // o paciente coberto não mexe de estado
    expect(await statusDe(xId)).toBe('ACTIVE');

    // (d)(e): nada para o destinatário só-BR — nem notificação nem despacho
    expect(await payloadsDe(U.rbr)).toHaveLength(0);
    expect(await despachosDe(U.rbr)).toHaveLength(0);
  });

  it('2ª chamada — (b)(f) 3 AR descobertos × 2 destinatários AR + 1 BR descoberto: 2 notificações, 2 despachos SKIPPED_TEST, payload com os 3 itens; BR fora dos AR; ON_HOLD fora de todos', async () => {
    // (a) sai de cena: senão seria um 4º item AR (SEARCHING, descoberto) nos payloads
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id IN (SELECT s.id FROM patient_itinerary_slot s JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id WHERE pcs.patient_id = $1)`, [paId]);
    await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id = $1`, [paId]);

    const mk = async (label: string, country: 'AR' | 'BR', status: string, assembled = true) => {
      const p = await mkPatient(label, country, status);
      await mkSlot(p.serviceId); // sem ninguém alocado: o turno de hoje é "Sin cubrir" (FR-12)
      if (assembled) await assemble(p.patientId, country);
      return p;
    };
    const a1 = await mk('1', 'AR', 'ACTIVE');
    const a2 = await mk('2', 'AR', 'ACTIVE');
    const a3 = await mk('3', 'AR', 'ACTIVE');
    ({ patientId: p1, serviceId: s1 } = a1);
    ({ patientId: p2, serviceId: s2 } = a2);
    ({ patientId: p3, serviceId: s3 } = a3);
    const hold = await mk('h', 'AR', 'ON_HOLD'); // montado, mas em estado manual travado
    holdId = hold.patientId;
    const z = await mk('z', 'BR', 'ACTIVE');
    ({ patientId: zId, serviceId: sZ } = z);

    await mkRecipient(U.ra, GRUPOS.ar, ['AR']);
    await mkRecipient(U.rb, `${GRUPOS.ar}-b`, ['AR']);

    const r = await daily();
    expect(r.status).toBe(200);
    expect(r.data.failures).toBe(0);
    expect(r.data.emailsSent).toBe(0); // canal de teste: nada SENT, nunca
    expect(r.data.operationDate).toBe(hoje);

    const meus = [p1, p2, p3].sort();
    for (const uid of [U.ra, U.rb]) {
      const payloads = await payloadsDe(uid);
      expect(payloads).toHaveLength(1);
      expect(payloads[0].operationDate).toBe(hoje);
      const ids = payloads[0].items.map((i) => i.patientId);
      expect(ids.filter((id) => [p1, p2, p3].includes(id)).sort()).toEqual(meus);
      expect(ids).not.toContain(zId); // BR fora de quem só vê AR (P10)
      expect(ids).not.toContain(holdId); // ON_HOLD montado fora do universo (P13)
      for (const it of payloads[0].items.filter((i) => [s1, s2, s3].includes(i.serviceId))) {
        expect(it).toEqual({ patientId: expect.any(String), serviceId: expect.any(String), shifts: 1, firstDate: hoje });
      }
      expect(JSON.stringify(payloads[0])).not.toMatch(/Pac[123hz]/); // nada de nome no payload in-app
      const d = await despachosDe(uid);
      expect(d).toEqual([{ email_status: 'SKIPPED_TEST', operation_date: hoje, email_error_code: null }]);
    }
    // (f) o destinatário só-BR recebe só o BR (X coberto e Y só em hoje+7 continuam fora)
    const br = await payloadsDe(U.rbr);
    expect(br).toHaveLength(1);
    expect(br[0].items.map((i) => i.patientId)).toEqual([zId]);
    expect((await despachosDe(U.rbr))[0].email_status).toBe('SKIPPED_TEST');
  });

  it('(c) 2ª chamada no dia → nada novo (a PK do despacho): mesmas linhas, mesmos payloads, 0 e-mails SENT', async () => {
    const antes = await Promise.all(Object.values(U).map(async (uid) => [(await payloadsDe(uid)).length, (await despachosDe(uid)).length]));
    expect(antes).toEqual([[1, 1], [1, 1], [1, 1]]);
    const r = await daily();
    expect(r.status).toBe(200);
    expect(r.data.failures).toBe(0);
    expect(r.data.emailsSent).toBe(0);
    expect(r.data.alreadySent).toBeGreaterThanOrEqual(3);
    const depois = await Promise.all(Object.values(U).map(async (uid) => [(await payloadsDe(uid)).length, (await despachosDe(uid)).length]));
    expect(depois).toEqual(antes);
  });

  it('(g) itinerary_daily_run terminado com failures = 0 nos dois países, na data de operação de cada um', async () => {
    const rows = await q<{ country: string; operation_date: string; finished: boolean; failures: number }>(
      `SELECT country, to_char(operation_date, 'YYYY-MM-DD') AS operation_date, finished_at IS NOT NULL AS finished, failures FROM itinerary_daily_run WHERE operation_date = $1::date ORDER BY country`,
      [hoje],
    );
    expect(rows).toEqual([
      { country: 'AR', operation_date: hoje, finished: true, failures: 0 },
      { country: 'BR', operation_date: hoje, finished: true, failures: 0 },
    ]);
  });

  it('T411 prova de 0 envio real: nenhum despacho SENT; em processo, o SDK do SendGrid recebe 0 chamadas — e o espião é acionável (controle positivo)', async () => {
    // (1) o banco: nada SENT para ninguém desta rodada
    const sent = await q(`SELECT 1 FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid = ANY($1) AND email_status = 'SENT'`, [Object.values(U)]);
    expect(sent).toHaveLength(0);

    // (2) em processo, e-mail REAL do EmailService, rodada nova para RA (apaga o despacho e a notificação de RA para o caso de uso refazê-los)
    await pool.query(`DELETE FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid = $1`, [U.ra]);
    await pool.query(`DELETE FROM notification_events WHERE id IN (SELECT event_id FROM notifications WHERE recipient_uid = $1)`, [U.ra]);
    mockSgSend.mockClear();
    expect(process.env.NODE_ENV).toBe('test');
    const result = await new UncoveredShiftsAlertUseCase().execute({ now: new Date(), countries: ['AR', 'BR'] });
    expect(result.failures).toBe(0);
    expect(result.notified).toBeGreaterThanOrEqual(1);
    expect(result.emailsSent).toBe(0);
    expect(mockSgSend).toHaveBeenCalledTimes(0);
    expect((await despachosDe(U.ra))[0].email_status).toBe('SKIPPED_TEST');

    // (3) controle positivo: SEM o guard (produção + chave) o espião SERIA acionado — logo o 0 acima mede alguma coisa
    const antes = { env: process.env.NODE_ENV, key: process.env.SENDGRID_API_KEY };
    try {
      process.env.NODE_ENV = 'production';
      process.env.SENDGRID_API_KEY = 'SG.chave-falsa-so-do-controle';
      mockSgSend.mockResolvedValue([{ statusCode: 202 }]);
      await new EmailService().sendItineraryUncoveredShiftsDigest(EMAIL('controle'), [{ patientId: 'p', patientName: 'N', serviceId: 's', serviceCode: 'AT', shifts: 1, firstDate: hoje }], hoje, 7);
      expect(mockSgSend).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = antes.env;
      if (antes.key === undefined) delete process.env.SENDGRID_API_KEY;
      else process.env.SENDGRID_API_KEY = antes.key;
    }
    mockSgSend.mockClear();
    await expect(new EmailService().sendItineraryUncoveredShiftsDigest(EMAIL('controle'), [], hoje, 7)).rejects.toBeInstanceOf(EmailChannelUnavailableError);
    expect(mockSgSend).toHaveBeenCalledTimes(0);
  });
});
