/**
 * enquadre-052-eventos.e2e.test.ts — spec 052, Fase 2 (T-30d): o evento de enquadre contra POSTGRES REAL, HTTP real, com o
 * ENGINE DE PERMISSÃO LIGADO (família `admin.vacancies`).
 *
 * Só a fronteira externa é dublê: o Google Calendar (`FakeAdmissionCalendar`, o MESMO objeto que o serviço usa, para o teste ler
 * `created[]`, `attendeeUpdates[]` e `deleted[]`) e o Pub/Sub. Nada toca canal real. Dados SINTÉTICOS: e-mails `@example.test`,
 * nomes "Ficticia"/"Ficticio NN". Nenhum e-mail, nome ou telefone entra em log ou asserção de mensagem.
 *
 * O que cada caso mata (sabotagem → vermelho):
 *   1 tirar o índice único `uq_enquadre_participant_um_aberto`          2 pôr o primeiro nome do paciente no título
 *   3 tirar o código ENC do título                                      4 deixar um escolhido fora dos convidados / ligar "modificar"
 *   5 gravar algo quando o Google falha (não fazer ROLLBACK)            6 encerrar sem carimbar / sem a nota do não marcado
 *   7 aceitar prestador sem e-mail válido                               8 cancelar sem liberar / sem apagar no Google
 *   9 mutar evento que não está aberto
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { titleHasExactCode } from '../../src/modules/matching/domain/admissionImport';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CAL_AR = 'cal-enquadre-ar-e2e052@example.test';
const HOST_OK = `ana.e2e052.${RUN}@example.test`;
const HOST_FALHA = `falha.e2e052.${RUN}@example.test`;
const PATIENT_FIRST = 'Ficticia';
const PATIENT_LAST = 'Sobrenomeunico';
const CASE_NUMBER = 900000 + Math.floor(Math.random() * 90000);
const VACANCY_TITLE = `ENQ052 e2e ${RUN}`;
const NOTE_RE = /^No fue marcado en el encuadre del \d{2}\/\d{2} \d{2}:\d{2}$/;

const UID = 'enq052-chefe';
const GRUPO = `Enq052 Chefe ${RUN}`;

describe('evento de enquadre — HTTP real, banco real, engine LIGADO (spec 052, F2)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let calendar: FakeAdmissionCalendar;
  let vacancyId: string;
  let patientId: string;
  let hostOkId: string;
  let hostFalhaId: string;
  const workers: string[] = [];
  const pubsubCalls: string[] = [];
  let seq = 0;
  let dayOffset = 20 + Math.floor(Math.random() * 200);

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const base = () => `/api/admin/vacancies/${vacancyId}/enquadre-events`;

  async function http(method: string, path: string, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { Authorization: tokenMock(UID, 'admin', 'AR'), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  /** Hora de parede futura e ÚNICA por chamada, no formato que a tela manda (sem offset). */
  function nextStart(): string {
    dayOffset += 1;
    return DateTime.now().setZone('America/Argentina/Buenos_Aires').plus({ days: dayOffset }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toFormat("yyyy-LL-dd'T'HH:mm");
  }

  /** Prestador com candidatura da vaga em COMPLETED. `email` explícito para o caso do e-mail inválido. */
  async function novoWorker(email?: string): Promise<string> {
    seq += 1;
    const { rows } = await admin.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'cipher', 'cipher') RETURNING id`,
      [`enq052-${RUN}-${seq}`, email ?? `worker${seq}.e2e052.${RUN}@example.test`],
    );
    const id = rows[0].id as string;
    workers.push(id);
    await admin.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'COMPLETED', 'talentum')`,
      [id, vacancyId],
    );
    return id;
  }

  const create = (workerIds: string[], hostId = hostOkId, startsAt = nextStart()) =>
    http('POST', base(), { hostId, startsAt, durationMinutes: 60, workerIds });

  const count = async (table: 'enquadre_events' | 'enquadre_event_participants'): Promise<number> =>
    (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE job_posting_id = $1`, [vacancyId])).rows[0].n as number;
  const eventRow = async (id: string) => (await admin.query(`SELECT * FROM enquadre_events WHERE id = $1`, [id])).rows[0];
  const participantsOf = async (eventId: string) =>
    (await admin.query(`SELECT worker_id, released_at, release_kind, outcome FROM enquadre_event_participants WHERE event_id = $1`, [eventId])).rows as Array<{
      worker_id: string; released_at: Date | null; release_kind: string | null; outcome: string | null;
    }>;
  const availableIds = async (): Promise<string[]> => {
    const res = await http('GET', `${base()}/available-workers`);
    expect(res.status).toBe(200);
    return (res.body.data.workers as Array<{ id: string }>).map((w) => w.id);
  };
  const systemNotes = async (workerIds: string[]) =>
    (await admin.query(
      `SELECT worker_id, note_text FROM wja_contact_notes WHERE job_posting_id = $1 AND created_by_admin_id = 'system:enquadre' AND worker_id = ANY($2)`,
      [vacancyId, workerIds],
    )).rows as Array<{ worker_id: string; note_text: string }>;
  /** Põe o evento no passado (como dona; `ends_at > starts_at` é CHECK, por isso os dois). */
  const makePast = (eventId: string) =>
    admin.query(`UPDATE enquadre_events SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [eventId]);

  async function limparTudo(): Promise<void> {
    await admin.query(`DELETE FROM job_postings WHERE title LIKE 'ENQ052 e2e %' AND (id = $1 OR $1::uuid IS NULL)`, [vacancyId ?? null]);
    await admin.query(`DELETE FROM interview_hosts WHERE email = ANY($1)`, [[HOST_OK, HOST_FALHA]]);
    await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [[HOST_OK, HOST_FALHA]]);
    await limparIamFixtures(admin, { uids: [UID], grupos: [GRUPO] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(admin, { uids: [UID], grupos: [GRUPO] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.vacancies');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
    setEnv('ENQUADRE_CALENDAR_ID_AR', CAL_AR);
    setEnv('ENQUADRE_GUEST_POLICY', 'allowlist:example.test');

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,'enq052-chefe@e2e.local','admin','ACTIVE',true,$2)`,
      [UID, TENANT_E2E],
    );
    await grupoComCelulas(admin, {
      nome: GRUPO,
      uid: UID,
      celulas: [['enquadre_event', 'read'], ['enquadre_event', 'create'], ['enquadre_event', 'update'], ['enquadre_result', 'update']],
    });

    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, $2, $3, 'AR', true) RETURNING id`,
      [`e2e-052-${RUN}`, PATIENT_FIRST, PATIENT_LAST],
    );
    patientId = pat.rows[0].id;
    const vac = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number)
       VALUES ($1, $2, 'SEARCHING', false, 'AR', true, $3) RETURNING id`,
      [VACANCY_TITLE, patientId, CASE_NUMBER],
    );
    vacancyId = vac.rows[0].id;

    const hosts = await admin.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Entrevistadora Uno','AR',true), ($2,'Entrevistadora Dos','AR',true) RETURNING id, email`,
      [HOST_OK, HOST_FALHA],
    );
    hostOkId = hosts.rows.find((r) => r.email === HOST_OK).id;
    hostFalhaId = hosts.rows.find((r) => r.email === HOST_FALHA).id;
    await admin.query(
      `INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$3,'linked'), ($2,$4,'linked')`,
      [HOST_OK, HOST_FALHA, `tq-ok-${RUN}`, `tq-falha-${RUN}`],
    );

    calendar = new FakeAdmissionCalendar();
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.vacancies',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { EnquadreEventService } = await import('../../src/modules/matching/application/EnquadreEventService');
        const { EnquadreEventMutations } = await import('../../src/modules/matching/application/EnquadreEventMutations');
        const { EnquadreEventController } = await import('../../src/modules/matching/interfaces/controllers/EnquadreEventController');
        const { createAdminEnquadreEventRoutes } = await import('../../src/modules/matching/interfaces/routes/adminEnquadreEventRoutes');
        const { interviewHostRepository } = await import('../../src/modules/matching/infrastructure/InterviewHostRepository');
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');

        const pool = DatabaseConnection.getInstance().getPool();
        // O gate de produção (TactiqLinkService.statesFor sobre o banco real); OAuth/MCP são dublês que nunca são chamados aqui.
        const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
        const service = new EnquadreEventService({
          db: pool,
          calendar,
          hosts: interviewHostRepository,
          tactiq,
          decryptor: { decrypt: async () => 'Ficticio NN' },
          env: process.env,
          impersonateEmail: 'enlite@enlite.health',
          calendarRetryDelaysMs: [],
        });
        const mutations = new EnquadreEventMutations({
          db: pool,
          calendar,
          env: process.env,
          impersonateEmail: 'enlite@enlite.health',
          readEvent: (v, e, viewer) => service.getEvent(v, e, viewer),
          pubsub: { publish: async (topic: string) => { pubsubCalls.push(topic); return 'msg'; } } as never,
        });
        express.use('/api/admin', createAdminEnquadreEventRoutes(auth, permissions, new EnquadreEventController(service, mutations)));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    // Só o que ESTE teste criou, por id. A vaga leva eventos e participações por CASCADE (provado pelo count abaixo).
    if (vacancyId) {
      await admin.query(`DELETE FROM wja_contact_notes WHERE job_posting_id = $1`, [vacancyId]);
      await admin.query(`DELETE FROM encuadres WHERE job_posting_id = $1`, [vacancyId]);
      await admin.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [vacancyId]);
      await admin.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
    }
    const sobra = await admin.query(
      `SELECT (SELECT count(*) FROM enquadre_events WHERE job_posting_id = $1)::int AS ev,
              (SELECT count(*) FROM enquadre_event_participants WHERE job_posting_id = $1)::int AS pa`,
      [vacancyId ?? null],
    );
    if (workers.length) await admin.query(`DELETE FROM workers WHERE id = ANY($1)`, [workers]);
    if (patientId) await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await limparTudo();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    expect(sobra.rows[0]).toEqual({ ev: 0, pa: 0 });
  });

  it('0. sanidade: a semente existe (vaga com paciente, 2 entrevistadoras vinculadas) e a vaga começa sem evento', async () => {
    const { rows } = await admin.query(
      `SELECT (SELECT count(*) FROM interview_hosts WHERE email = ANY($1) AND active)::int AS hosts,
              (SELECT count(*) FROM tactiq_links WHERE lower(host_email) = ANY($1) AND status = 'linked')::int AS links,
              (SELECT count(*) FROM job_postings jp JOIN patients p ON p.id = jp.patient_id WHERE jp.id = $2 AND p.last_name = $3)::int AS vaga`,
      [[HOST_OK, HOST_FALHA], vacancyId, PATIENT_LAST],
    );
    expect(rows[0]).toEqual({ hosts: 2, links: 2, vaga: 1 });
    expect(await count('enquadre_events')).toBe(0);
    const w = await novoWorker();
    expect(await availableIds()).toContain(w);
  });

  it('1. trava: o mesmo prestador não entra em 2 eventos abertos da vaga — o 2º é 409 e o Google não recebe a 2ª criação', async () => {
    const w1 = await novoWorker();
    const antesCalendar = calendar.created.length;
    const a = await create([w1]);
    expect(a.status).toBe(201);
    const b = await create([w1]);
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('ENQUADRE_WORKER_NOT_AVAILABLE');

    const eventos = await admin.query(`SELECT count(*)::int AS n FROM enquadre_event_participants WHERE worker_id = $1 AND released_at IS NULL`, [w1]);
    expect(eventos.rows[0].n).toBe(1);
    const ev = await admin.query(`SELECT count(DISTINCT event_id)::int AS n FROM enquadre_event_participants WHERE worker_id = $1`, [w1]);
    expect(ev.rows[0].n).toBe(1);
    expect(calendar.created.length - antesCalendar).toBe(1);
  });

  it('2. título sem nome: o summary NÃO tem o primeiro nome do paciente e TEM o sobrenome e o nº do caso', async () => {
    const w = await novoWorker();
    const res = await create([w]);
    expect(res.status).toBe(201);
    const summary = calendar.created[calendar.created.length - 1].summary;
    expect(summary).not.toContain(PATIENT_FIRST);
    expect(summary).toContain(PATIENT_LAST);
    expect(summary).toContain(`Caso ${CASE_NUMBER}`);
  });

  it('3. título com código: titleHasExactCode(summary, event_code do banco) e o formato ENC-XXXXXX', async () => {
    const w = await novoWorker();
    const res = await create([w]);
    expect(res.status).toBe(201);
    const summary = calendar.created[calendar.created.length - 1].summary;
    const code = (await eventRow(res.body.data.id)).event_code as string;
    expect(code).toMatch(/^ENC-[0-9A-Z]{6}$/);
    expect(titleHasExactCode(summary, code)).toBe(true);
    expect(titleHasExactCode(summary, 'ENC-ZZZZZZ')).toBe(false); // controle: o teste sabe dizer "não"
  });

  it('4. todos os escolhidos são convidados (entrevistadora + 3) e o corpo desliga modificar / ver outros / convidar', async () => {
    const ids = [await novoWorker(), await novoWorker(), await novoWorker()];
    const emails = (await admin.query(`SELECT email FROM workers WHERE id = ANY($1)`, [ids])).rows.map((r) => r.email as string);
    const res = await create(ids);
    expect(res.status).toBe(201);
    const params = calendar.created[calendar.created.length - 1];
    expect([params.coHostEmail, ...(params.extraAttendeeEmails ?? [])].sort()).toEqual([HOST_OK, ...emails].sort());
    expect(params.guestsCanModify).toBe(false);
    expect(params.guestsCanSeeOtherGuests).toBe(false);
    expect(params.guestsCanInviteOthers).toBe(false);
  });

  it('5. Google falha: 502 CALENDAR_CREATE_FAILED e NADA gravado (eventos e participações inalterados); os prestadores seguem disponíveis', async () => {
    const w = await novoWorker();
    const antes = { ev: await count('enquadre_events'), pa: await count('enquadre_event_participants'), cal: calendar.created.length };
    const res = await create([w], hostFalhaId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CALENDAR_CREATE_FAILED');
    const depois = { ev: await count('enquadre_events'), pa: await count('enquadre_event_participants'), cal: calendar.created.length };
    // eslint-disable-next-line no-console
    console.log(`[enquadre-052 caso 5] antes=${JSON.stringify(antes)} depois=${JSON.stringify(depois)}`);
    expect(depois).toEqual(antes);
    expect(await availableIds()).toContain(w);
  });

  it('6. encerrar com não marcados: carimbos selected/rejected/returned, 1 nota de sistema só para o não marcado, histórico das 2 marcações, e o devolvido volta a ser convocável', async () => {
    const [a, b, c] = [await novoWorker(), await novoWorker(), await novoWorker()];
    const created = await create([a, b, c]);
    expect(created.status).toBe(201);
    const eventId = created.body.data.id as string;
    await makePast(eventId);
    const pid = (workerId: string) => (created.body.data.participants as Array<{ id: string; workerId: string }>).find((p) => p.workerId === workerId)!.id;

    const sel = await http('PUT', `${base()}/${eventId}/participants/${pid(a)}/move`, { column: 'SELECTED' });
    expect(sel.status).toBe(200);
    const rej = await http('PUT', `${base()}/${eventId}/participants/${pid(b)}/move`, { column: 'REJECTED', reason: 'DISTANCE' });
    expect(rej.status).toBe(200);

    const closed = await http('POST', `${base()}/${eventId}/close`);
    expect(closed.status).toBe(200);
    expect((await eventRow(eventId)).status).toBe('closed');

    const byWorker = new Map((await participantsOf(eventId)).map((p) => [p.worker_id, p]));
    expect(byWorker.get(a)).toMatchObject({ outcome: 'selected', release_kind: 'closed' });
    expect(byWorker.get(b)).toMatchObject({ outcome: 'rejected', release_kind: 'closed' });
    expect(byWorker.get(c)).toMatchObject({ outcome: 'returned', release_kind: 'closed' });

    const notas = await systemNotes([a, b, c]);
    expect(notas).toHaveLength(1);
    expect(notas[0].worker_id).toBe(c);
    expect(notas[0].note_text).toMatch(NOTE_RE);

    const hist = await admin.query(
      `SELECT wja.worker_id, h.new_value FROM worker_job_application_stage_history h
         JOIN worker_job_applications wja ON wja.id = h.application_id
        WHERE wja.job_posting_id = $1 AND wja.worker_id = ANY($2) AND h.field_name = 'application_funnel_stage' AND h.new_value IN ('SELECTED','REJECTED')`,
      [vacancyId, [a, b, c]],
    );
    expect(hist.rows.map((r) => `${r.worker_id}:${r.new_value}`).sort()).toEqual([`${a}:SELECTED`, `${b}:REJECTED`].sort());

    const disponiveis = await availableIds();
    expect(disponiveis).toContain(c);
    expect(disponiveis).not.toContain(a);
    expect(disponiveis).not.toContain(b);
    const segundo = await create([c]);
    expect(segundo.status).toBe(201);
  });

  it('7. prestador sem e-mail válido: 422 ENQUADRE_WORKER_EMAIL_INVALID, 0 criações no Google e nenhum evento novo', async () => {
    const ok = await novoWorker();
    const sem = await novoWorker('sem-email-valido');
    const antes = { ev: await count('enquadre_events'), cal: calendar.created.length };
    const res = await create([ok, sem]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ENQUADRE_WORKER_EMAIL_INVALID');
    expect({ ev: await count('enquadre_events'), cal: calendar.created.length }).toEqual(antes);
  });

  it('8. cancelar libera: participações cancelled, evento apagado no Google, 1 nota de sistema por liberado, todos de volta a disponíveis', async () => {
    const [a, b] = [await novoWorker(), await novoWorker()];
    const created = await create([a, b]);
    expect(created.status).toBe(201);
    const eventId = created.body.data.id as string;
    const calendarEventId = (await eventRow(eventId)).calendar_event_id as string;
    expect(calendarEventId).toBeTruthy();

    const res = await http('POST', `${base()}/${eventId}/cancel`);
    expect(res.status).toBe(200);
    expect((await eventRow(eventId)).status).toBe('cancelled');
    const parts = await participantsOf(eventId);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.release_kind === 'cancelled' && p.released_at !== null)).toBe(true);
    expect(calendar.deleted.map((d) => d.eventId)).toContain(calendarEventId);
    const notas = await systemNotes([a, b]);
    expect(notas.map((n) => n.worker_id).sort()).toEqual([a, b].sort());
    const disponiveis = await availableIds();
    expect(disponiveis).toEqual(expect.arrayContaining([a, b]));
  });

  it('9. evento encerrado é imutável: acrescentar, mover e cancelar → 409 ENQUADRE_EVENT_NOT_OPEN', async () => {
    const [a, extra] = [await novoWorker(), await novoWorker()];
    const created = await create([a]);
    expect(created.status).toBe(201);
    const eventId = created.body.data.id as string;
    const participantId = created.body.data.participants[0].id as string;
    await makePast(eventId);
    expect((await http('POST', `${base()}/${eventId}/close`)).status).toBe(200);

    const attendeesAntes = calendar.attendeeUpdates.length;
    const deletedAntes = calendar.deleted.length;
    const add = await http('POST', `${base()}/${eventId}/participants`, { workerIds: [extra] });
    const move = await http('PUT', `${base()}/${eventId}/participants/${participantId}/move`, { column: 'SELECTED' });
    const cancel = await http('POST', `${base()}/${eventId}/cancel`);
    for (const r of [add, move, cancel]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ENQUADRE_EVENT_NOT_OPEN');
    }
    expect((await eventRow(eventId)).status).toBe('closed');
    expect(calendar.attendeeUpdates.length).toBe(attendeesAntes);
    expect(calendar.deleted.length).toBe(deletedAntes);
    expect(await availableIds()).toContain(extra);
  });
});
