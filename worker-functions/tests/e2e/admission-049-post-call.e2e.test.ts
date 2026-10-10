/**
 * admission-049-post-call.e2e.test.ts — spec 049, F5: o job de 15 min (fim REAL da call pela Meet API, `no_show`, detectores
 * de silêncio) contra POSTGRES REAL. Só a Meet API é dublê (`FakeMeetConference`, injetado na MESMA classe que o `index.ts`
 * monta); o job não tem Tactiq nem cofre por construção. Dados SINTÉTICOS (@example.test, telefone/nomes de teste); nada toca canal real.
 *
 * Relógio: o `now` do job é injetado; as reuniões nascem relativas a ele. Cada teste apaga as próprias reuniões.
 * A5-1 fim real · A5-2 no_show sem conferência · A5-3 escopo (H2) vira blocked, não no_show · A5-4 silêncio do lembrete
 * A5-5 silêncio da confirmação · A5-6 (escopo do token DWD) está na unidade `GoogleCalendarEventFinder.scope.test.ts`.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { FakeMeetConference } from '../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { AdmissionPostCallJob } from '../../src/modules/matching/application/AdmissionPostCallJob';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.API_URL || 'http://localhost:8080';
const SECRET = 'test-secret-for-e2e-only';

const RUN = Date.now().toString(36);
const MIN = 60_000;
const PHONE = '+5491155550149';
const FIRST_NAME = 'Carlota';
const LAST_NAME = `Sintetica${RUN}`;
const MEET_CODE = 'abc-defg-hij';
const MEET_LINK = `https://meet.google.com/${MEET_CODE}`;

describe('job de 15 min da admissão — fim real, no_show e silêncio (spec 049, F5)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let fake: FakeMeetConference;
  let job: AdmissionPostCallJob;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  const patients: Record<'ok' | 'semConsentimento' | 'semTelefone' | 'teste', string> = { ok: '', semConsentimento: '', semTelefone: '', teste: '' };
  const patientIds = (): string[] => Object.values(patients);
  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const code = (): string => `ADM-${(RUN + String(seq).padStart(3, '0')).toUpperCase().slice(-6)}`;

  /** Reunião relativa ao relógio. `startedMinAgo` = minutos desde slot_start; duração 30 min. */
  async function appt(opts: {
    startedMinAgo: number;
    patient?: keyof typeof patients;
    status?: string;
    withCode?: boolean;
    meetLink?: string | null;
    meetSpace?: string | null;
    createdMinAgo?: number;
    importStatus?: string | null;
  }): Promise<string> {
    seq += 1;
    const start = new Date(clock.getTime() - opts.startedMinAgo * MIN);
    const end = new Date(start.getTime() + 30 * MIN);
    const created = new Date(clock.getTime() - (opts.createdMinAgo ?? opts.startedMinAgo + 60) * MIN);
    const { rows } = await admin.query(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, meet_space_name,
          admission_code, created_at, import_status)
       VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        patients[opts.patient ?? 'ok'], `host${seq}.${RUN}@example.test`, start, end, opts.status ?? 'booked',
        opts.meetLink === undefined ? MEET_LINK : opts.meetLink, opts.meetSpace ?? null,
        opts.withCode === false ? null : code(), created, opts.importStatus ?? null,
      ],
    );
    return rows[0].id;
  }

  const row = async (id: string) =>
    (await admin.query(
      `SELECT status, import_status, conference_ended_at, meet_space_name, import_attempts, updated_at FROM admission_appointments WHERE id = $1`, [id])).rows[0];
  const events = async (id: string, like = '%') =>
    (await admin.query(`SELECT kind, outcome, reason, ref FROM admission_events WHERE appointment_id = $1 AND kind LIKE $2 ORDER BY at, kind`, [id, like])).rows as
      Array<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, unknown> | null }>;
  const logLines = (msg: string) =>
    logs.output().split('\n').filter((l) => l.includes(`"message":"${msg}"`)).map((l) => JSON.parse(l) as { appointmentId?: string; reason?: string });
  const msgFor = (msg: string, ids: string[]) => logLines(msg).filter((l) => l.appointmentId && ids.includes(l.appointmentId));

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM patient_documents WHERE patient_id = ANY($1)`, [patientIds()]);
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1)`, [patientIds()]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('INTERNAL_TOKEN_SECRET', SECRET);

    const mk = async (tag: string, o: { consent: boolean | null; phone: string | null; test: boolean }): Promise<string> => {
      const { rows } = await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
         VALUES ($1,$2,$3,'AR',$4,$5,$6) RETURNING id`,
        [`e2e-049-pc-${tag}-${RUN}`, FIRST_NAME, LAST_NAME, o.test, o.consent, o.phone],
      );
      return rows[0].id;
    };
    patients.ok = await mk('ok', { consent: true, phone: PHONE, test: false });
    patients.semConsentimento = await mk('nc', { consent: false, phone: PHONE, test: false });
    patients.semTelefone = await mk('np', { consent: true, phone: null, test: false });
    patients.teste = await mk('t', { consent: true, phone: PHONE, test: true });

    fake = new FakeMeetConference();
    logs = capturingLogger();

    app = await montarAppDeFamilia({
      montarRotas: async ({ app: express }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
        const { internalAuthMiddleware } = await import('@modules/notification/interfaces/middleware/InternalAuthMiddleware');
        const { AdmissionPostCallJob: Job } = await import('../../src/modules/matching/application/AdmissionPostCallJob');
        const { AdmissionPostCallRepository } = await import('../../src/modules/matching/infrastructure/AdmissionPostCallRepository');
        const { AdmissionEventRepository } = await import('../../src/modules/matching/infrastructure/AdmissionEventRepository');
        const { AdmissionPostCallInternalController } = await import('../../src/modules/matching/interfaces/controllers/AdmissionPostCallInternalController');
        const { createAdmissionPostCallInternalRoutes } = await import('../../src/modules/matching/interfaces/routes/admissionPostCallRoutes');
        const pool = DatabaseConnection.getInstance().getPool();
        job = new Job({
          repo: new AdmissionPostCallRepository(pool), meet: fake, events: new AdmissionEventRepository(pool),
          db: pool, log: logs.log, now: () => clock,
        });
        express.use('/api/internal', systemContextMiddleware('job:admission-post-call'), internalAuthMiddleware,
          createAdmissionPostCallInternalRoutes(new AdmissionPostCallInternalController(job)));
      },
    });
  }, 60000);

  beforeEach(async () => {
    clock = new Date();
    fake.reset();
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patientIds()]);
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── A5-1 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A5-1: todas as conferências terminadas → conference_ended_at = o MAIOR endTime, import_status=pending, espaço guardado, evento com os ids; rodar 2× não muda nada', async () => {
    const id = await appt({ startedMinAgo: 120 });
    const t0 = new Date(clock.getTime() - 118 * MIN);
    const t1 = new Date(clock.getTime() - 70 * MIN);
    fake.setRecords(MEET_CODE, [
      { name: 'conferenceRecords/p1', startTime: new Date(t0.getTime() - 10 * MIN), endTime: t0 },
      { name: 'conferenceRecords/p2', startTime: new Date(t0.getTime() + 4 * MIN), endTime: t1 },
    ]);

    const s1 = await job.runOnce(clock);
    expect(s1.ended).toBeGreaterThanOrEqual(1);
    const after1 = await row(id);
    expect(after1.import_status).toBe('pending');
    expect(after1.status).toBe('booked');
    expect(new Date(after1.conference_ended_at).toISOString()).toBe(t1.toISOString());
    expect(after1.meet_space_name).toBe(`spaces/${MEET_CODE}`);
    const ev1 = await events(id);
    expect(ev1).toHaveLength(1);
    expect(ev1[0]).toMatchObject({ kind: 'conference_ended', outcome: 'ended' });
    expect(ev1[0].ref).toMatchObject({ parts: 2, conferenceRecords: 'conferenceRecords/p1,conferenceRecords/p2' });

    // 2ª execução: terminal 'pending' sai da fila — mesmo estado, mesma trilha, zero chamadas novas à Meet API
    const callsBefore = fake.listCalls.length;
    await job.runOnce(clock);
    expect(await row(id)).toEqual(after1);
    expect(await events(id)).toEqual(ev1);
    expect(fake.listCalls.length).toBe(callsBefore);
  });

  it('A5-1: conferência ainda ABERTA (sem endTime) → NADA muda (nem estado, nem trilha, nem updated_at)', async () => {
    const id = await appt({ startedMinAgo: 40, meetSpace: `spaces/${MEET_CODE}` });
    fake.setRecords(MEET_CODE, [{ name: 'conferenceRecords/aberta', startTime: new Date(clock.getTime() - 38 * MIN), endTime: null }]);
    const before = await row(id);
    const s = await job.runOnce(clock);
    expect(s.waiting).toBeGreaterThanOrEqual(1);
    expect(fake.listCalls).toContain(`spaces/${MEET_CODE}`); // a Meet API FOI consultada (o "nada muda" não é "nem olhou")
    expect(await row(id)).toEqual(before);
    expect(await events(id)).toEqual([]);
  });

  it('A5-1: reunião ANTIGA (sem código ADM), cancelada, ou com fim há mais de 72 h → fora do job (a Meet API nem é consultada)', async () => {
    const idAntiga = await appt({ startedMinAgo: 120, withCode: false });
    const idCancelada = await appt({ startedMinAgo: 120, status: 'cancelled' });
    const idVelha = await appt({ startedMinAgo: 73 * 60 + 30 });
    fake.setRecords(MEET_CODE, [{ name: 'conferenceRecords/x', startTime: clock, endTime: clock }]);
    await job.runOnce(clock);
    for (const id of [idAntiga, idCancelada, idVelha]) {
      expect((await row(id)).import_status).toBeNull();
      expect(await events(id)).toEqual([]);
    }
    expect(fake.resolveCalls).toEqual([]);
  });

  // ── A5-2 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A5-2: nenhuma conferência até slot_start + 1 h → no_show (reunião e importação), evento e alarme; 0 documentos; 2ª execução não repete', async () => {
    const id = await appt({ startedMinAgo: 61, meetSpace: `spaces/${MEET_CODE}` }); // sem records programados → lista vazia
    const s = await job.runOnce(clock);
    expect(s.noShow).toBeGreaterThanOrEqual(1);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'no_show', import_status: 'no_show', conference_ended_at: null });
    expect(await events(id)).toMatchObject([{ kind: 'no_show', outcome: 'no_show', reason: 'no_conference_record' }]);
    expect(msgFor('admission.no_show', [id])).toHaveLength(1);
    // 0 objetos para o cofre / 0 documentos / nenhuma etapa de importação na trilha
    expect((await admin.query(`SELECT count(*)::int AS n FROM patient_documents WHERE patient_id = ANY($1)`, [patientIds()])).rows[0].n).toBe(0);
    expect((await events(id, 'import_%')).length + (await events(id, 'transcript_%')).length).toBe(0);

    await job.runOnce(clock);
    expect(await row(id)).toEqual(r);
    expect(await events(id)).toHaveLength(1);
    expect(msgFor('admission.no_show', [id])).toHaveLength(1);
  });

  it('A5-2 (limite): lista vazia a 59 min do início ainda ESPERA (a call pode começar atrasada) — não vira no_show nem pending', async () => {
    const id = await appt({ startedMinAgo: 59, meetSpace: `spaces/${MEET_CODE}` });
    const before = await row(id);
    await job.runOnce(clock);
    expect(await row(id)).toEqual(before);
    expect(await events(id)).toEqual([]);
  });

  // ── A5-3 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A5-3: Meet API recusa o escopo (H2 aberto) → blocked reason=meet_scope_missing, NUNCA no_show; 1 evento só; alarme a cada execução; o job não cai; ao liberar, segue para pending', async () => {
    fake.scopeMissing();
    const id = await appt({ startedMinAgo: 90 }); // passou de 1 h: com lista vazia seria no_show — o bloqueio não pode virar isso
    const s1 = await job.runOnce(clock);
    expect(s1.blocked).toBeGreaterThanOrEqual(1);
    expect(s1.errors).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'booked', import_status: 'blocked' });
    expect(await events(id)).toMatchObject([{ kind: 'import_blocked', outcome: 'blocked', reason: 'meet_scope_missing' }]);
    expect(msgFor('admission.import_blocked', [id])).toEqual([expect.objectContaining({ reason: 'meet_scope_missing' })]);

    await job.runOnce(clock); // continua bloqueada: sem evento novo, mas o alarme repete (sinal de estado)
    expect(await events(id)).toHaveLength(1);
    expect(msgFor('admission.import_blocked', [id])).toHaveLength(2);

    fake.failWith(null); // o super admin liberou o escopo
    fake.setRecords(MEET_CODE, [{ name: 'conferenceRecords/ok', startTime: new Date(clock.getTime() - 88 * MIN), endTime: new Date(clock.getTime() - 60 * MIN) }]);
    await job.runOnce(clock);
    expect(await row(id)).toMatchObject({ status: 'booked', import_status: 'pending' });
    expect((await events(id)).map((e) => [e.kind, e.reason])).toEqual([['import_blocked', 'meet_scope_missing'], ['conference_ended', 'unblocked']]);
  });

  it('A5-3: falha transitória (rede/5xx) não prova nada: estado e trilha intactos, contada como transient; reunião sem link do Meet → blocked no_meet_link', async () => {
    const idRede = await appt({ startedMinAgo: 90 });
    const idSemLink = await appt({ startedMinAgo: 90, meetLink: null });
    fake.transient('http_503');
    const before = await row(idRede);
    const s = await job.runOnce(clock);
    expect(s.transient).toBeGreaterThanOrEqual(1);
    expect(await row(idRede)).toEqual(before);
    expect(await events(idRede)).toEqual([]);
    // sem link o Meet nem é perguntado: o bloqueio é por dado, não por rede
    expect(await row(idSemLink)).toMatchObject({ import_status: 'blocked' });
    expect(await events(idSemLink)).toMatchObject([{ kind: 'import_blocked', reason: 'no_meet_link' }]);
  });

  // ── execução sobreposta ──────────────────────────────────────────────────────────────────────────
  it('SKIP LOCKED: duas execuções SOBREPOSTAS (Meet API lenta) processam a reunião UMA vez — 1 evento, e a outra a conta como skippedLocked', async () => {
    const id = await appt({ startedMinAgo: 120 });
    fake.setRecords(MEET_CODE, [{ name: 'conferenceRecords/c', startTime: new Date(clock.getTime() - 118 * MIN), endTime: new Date(clock.getTime() - 100 * MIN) }]);
    fake.delayMs = 400;
    const [a, b] = await Promise.all([job.runOnce(clock), job.runOnce(clock)]);
    expect(a.ended + b.ended).toBe(1);
    expect(a.skippedLocked + b.skippedLocked).toBeGreaterThanOrEqual(1);
    expect(await events(id)).toHaveLength(1);
    expect((await row(id)).import_status).toBe('pending');
  });

  it('idempotência: rodar o job 2× sobre um conjunto misto (fim real, no_show, espera) dá o MESMO banco', async () => {
    const idFim = await appt({ startedMinAgo: 120 });
    const idNoShow = await appt({ startedMinAgo: 70, meetSpace: 'spaces/sem-ninguem' });
    const idEspera = await appt({ startedMinAgo: 40, meetSpace: 'spaces/em-curso' });
    fake.setRecords(MEET_CODE, [{ name: 'conferenceRecords/f', startTime: new Date(clock.getTime() - 118 * MIN), endTime: new Date(clock.getTime() - 100 * MIN) }]);
    fake.setRecords('em-curso', [{ name: 'conferenceRecords/e', startTime: new Date(clock.getTime() - 35 * MIN), endTime: null }]);
    const snap = async () => JSON.stringify([
      await Promise.all([idFim, idNoShow, idEspera].map(async (i) => ({ r: await row(i), e: await events(i) }))),
    ]);
    await job.runOnce(clock);
    const um = await snap();
    await job.runOnce(clock);
    expect(await snap()).toBe(um);
    expect(JSON.parse(um)[0].map((x: { r: { import_status: string | null } }) => x.r.import_status)).toEqual(['pending', 'no_show', null]);
  });

  // ── A5-4 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A5-4: silêncio do LEMBRETE — com consentimento+telefone, começou e sem reminder_sent → 1 log; com reminder_sent, sem consentimento, sem telefone, paciente de teste, ainda não começou, marcada em cima da hora ou cancelada → 0', async () => {
    const silencio = await appt({ startedMinAgo: 5 });
    const enviado = await appt({ startedMinAgo: 5 });
    await admin.query(`INSERT INTO admission_messages (appointment_id, kind, attempt, status) VALUES ($1,'reminder_30min',0,'delivered')`, [enviado]);
    const semConsent = await appt({ startedMinAgo: 5, patient: 'semConsentimento' });
    const semFone = await appt({ startedMinAgo: 5, patient: 'semTelefone' });
    const paciTeste = await appt({ startedMinAgo: 5, patient: 'teste' });
    const naoComecou = await appt({ startedMinAgo: -20, createdMinAgo: 600 });
    const emCimaDaHora = await appt({ startedMinAgo: 5 });
    await admin.query(`INSERT INTO admission_events (appointment_id, kind, outcome, reason) VALUES ($1,'skipped_slot_too_soon','skipped','slot_too_soon')`, [emCimaDaHora]);
    const cancelada = await appt({ startedMinAgo: 5, status: 'cancelled' });
    const antiga = await appt({ startedMinAgo: 5, withCode: false });
    const todos = [silencio, enviado, semConsent, semFone, paciTeste, naoComecou, emCimaDaHora, cancelada, antiga];

    const s = await job.runOnce(clock);
    expect(s.silenceReminder).toBeGreaterThanOrEqual(1);
    expect(msgFor('admission.silence.reminder', todos).map((l) => l.appointmentId)).toEqual([silencio]);

    // sinal de ESTADO: enquanto durar, 1 log por reunião por execução (a ausência não se cala sozinha)
    await job.runOnce(clock);
    expect(msgFor('admission.silence.reminder', todos).map((l) => l.appointmentId)).toEqual([silencio, silencio]);
  });

  // ── A5-5 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A5-5: silêncio da CONFIRMAÇÃO — 11 min sem linha → 1 log; 9 min → 0; com linha de confirmação (até skipped_*) → 0; reunião antiga ou cancelada → 0', async () => {
    const onze = await appt({ startedMinAgo: -300, createdMinAgo: 11 });
    const nove = await appt({ startedMinAgo: -300, createdMinAgo: 9 });
    const comLinha = await appt({ startedMinAgo: -300, createdMinAgo: 11 });
    await admin.query(`INSERT INTO admission_messages (appointment_id, kind, attempt, status) VALUES ($1,'confirmation',0,'skipped_no_consent')`, [comLinha]);
    const antiga = await appt({ startedMinAgo: -300, createdMinAgo: 11, withCode: false });
    const cancelada = await appt({ startedMinAgo: -300, createdMinAgo: 11, status: 'cancelled' });
    const velha = await appt({ startedMinAgo: -300, createdMinAgo: 73 * 60 });
    const todos = [onze, nove, comLinha, antiga, cancelada, velha];

    const s = await job.runOnce(clock);
    expect(s.silenceConfirmation).toBeGreaterThanOrEqual(1);
    expect(msgFor('admission.silence.confirmation', todos).map((l) => l.appointmentId)).toEqual([onze]);
  });

  // ── rota interna + logs ──────────────────────────────────────────────────────────────────────────
  it('rota POST /api/internal/jobs/admission-post-call: sem segredo 403; com segredo 200 e SÓ contagens numéricas', async () => {
    await appt({ startedMinAgo: 120 });
    const negado = await fetch(`${app.url}/api/internal/jobs/admission-post-call`, { method: 'POST' });
    expect(negado.status).toBe(403);
    const ok = await fetch(`${app.url}/api/internal/jobs/admission-post-call`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([
      'blocked', 'candidates', 'ended', 'errors', 'noShow', 'silenceConfirmation', 'silenceReminder', 'skippedLocked', 'skippedTest', 'transient', 'waiting',
    ]);
    expect(Object.values(body.data).every((v) => typeof v === 'number')).toBe(true);
    expect(body.data.candidates as number).toBeGreaterThanOrEqual(1);
  });

  it('log e trilha SEM PII: telefone, nome, e-mail do responsável e link do Meet nunca aparecem (asserção sobre a saída do logger e sobre admission_events.ref)', async () => {
    const id = await appt({ startedMinAgo: 90 });
    fake.scopeMissing();
    await job.runOnce(clock);
    fake.failWith(null);
    fake.setRecords(MEET_CODE, [{ name: 'conferenceRecords/pii', startTime: new Date(clock.getTime() - 88 * MIN), endTime: new Date(clock.getTime() - 60 * MIN) }]);
    await job.runOnce(clock);
    await appt({ startedMinAgo: 5 }); // dispara o silêncio do lembrete na saída do logger

    const out = logs.output();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('admission.import_blocked'); // o que se mede existe (zero não é sucesso)
    expect(out).toContain('admission.conference_ended');
    const host = (await admin.query(`SELECT host_email FROM admission_appointments WHERE id = $1`, [id])).rows[0].host_email as string;
    for (const proibido of [PHONE, FIRST_NAME, LAST_NAME, host, MEET_LINK, MEET_CODE, 'meet.google.com']) {
      expect(out).not.toContain(proibido);
    }
    const trilha = JSON.stringify((await events(id)));
    for (const proibido of [PHONE, FIRST_NAME, host, MEET_LINK, MEET_CODE]) expect(trilha).not.toContain(proibido);
  });

  // ── stack completa (engine ligado, API em container com ADMISSION_EXTERNALS=fake) ────────────────
  const stack = process.env.E2E_ABAC_STACK === '1' ? it : it.skip;
  stack('stack completa: a rota existe no index.ts de verdade — sem segredo 403, com segredo 200 com contagens (a Meet API da stack é o dublê)', async () => {
    const negado = await fetch(`${API_URL}/api/internal/jobs/admission-post-call`, { method: 'POST' });
    expect(negado.status).toBe(403);
    const ok = await fetch(`${API_URL}/api/internal/jobs/admission-post-call`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: Record<string, unknown> };
    expect(Object.values(body.data).every((v) => typeof v === 'number')).toBe(true);
  });
});
