/**
 * enquadre-052-post-call.e2e.test.ts — spec 052, Fase 3 (T-34b): o job de FIM DE CALL do enquadre contra POSTGRES REAL. É a MESMA
 * classe da admissão (`AdmissionPostCallJob`) instanciada com a fonte (`EnquadrePostCallRepository`) e a trilha
 * (`EnquadreEventTrailRepository`) do enquadre, sobre `enquadre_events` (migrations 518 e 521), SEM paciente no caminho. Só a Meet
 * API é dublê (`FakeMeetConference`). Dados SINTÉTICOS; nada toca Tactiq, Meet, Vertex nem cofre; os logs só levam ids e contagens.
 *
 * Casos: A call terminou → `pending` (estado de "buscar a transcrição") · B ninguém entrou → `no_show` · C bloqueios (escopo do
 * Meet, sem link) com o motivo e a saída do bloqueio · D quem entra na fila (open|closed sim; cancelado, futuro e velho não) ·
 * E trava (duas execuções simultâneas) · F lote próprio · G trilha imutável · H rota interna · I esquema da 521 · log sem dado pessoal.
 * A rota de importação (e "responsável sem vínculo do Tactiq → blocked", que é da importação) é da rodada 2 da Fase 3.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { FakeMeetConference } from '../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { criarEscopoDeEnv } from './helpers/admissionHarnessKit';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { AdmissionPostCallJob } from '../../src/modules/matching/application/AdmissionPostCallJob';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SECRET = 'test-secret-for-e2e-only';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
const MIN = 60_000;
const MEET_CODE = 'abc-defg-hij';
const MEET_LINK = `https://meet.google.com/${MEET_CODE}`;
const POSTING_TITLE = `ENQ052 post-call ${RUN}`;

describe('fim de call do enquadre — mesma lógica da admissão, fonte e trilha do enquadre (spec 052, F3)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let fake: FakeMeetConference;
  let job: AdmissionPostCallJob;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  let patientId = '';
  let postingId = '';
  const env = criarEscopoDeEnv();

  const code = (): string => `ENC-${(RUN + String(seq).padStart(3, '0')).slice(-6)}`;

  /** Evento relativo ao relógio. `startedMinAgo` = minutos desde `starts_at`; duração 30 min. */
  async function ev(o: { startedMinAgo: number; status?: string; meetLink?: string | null; meetSpace?: string | null; importStatus?: string | null }): Promise<string> {
    seq += 1;
    const start = new Date(clock.getTime() - o.startedMinAgo * MIN);
    const end = new Date(start.getTime() + 30 * MIN);
    const status = o.status ?? 'open';
    const { rows } = await admin.query(
      `INSERT INTO enquadre_events
         (job_posting_id, country, host_email, host_display_name, starts_at, ends_at, event_code, status, meet_link, meet_space_name,
          created_by_uid, import_status, closed_at, closed_by_uid, cancelled_at, cancelled_by_uid)
       VALUES ($1,'AR',$2,'Entrevistadora Sintetica',$3,$4,$5,$6,$7,$8,'enq052-uid',$9,
               CASE WHEN $6 = 'closed' THEN now() END, CASE WHEN $6 = 'closed' THEN 'enq052-uid' END,
               CASE WHEN $6 = 'cancelled' THEN now() END, CASE WHEN $6 = 'cancelled' THEN 'enq052-uid' END) RETURNING id`,
      [postingId, `host${seq}.${RUN}@example.test`.toLowerCase(), start, end, code(), status,
        o.meetLink === undefined ? MEET_LINK : o.meetLink, o.meetSpace ?? null, o.importStatus ?? null],
    );
    return rows[0].id;
  }

  const row = async (id: string) =>
    (await admin.query(
      `SELECT status, import_status, blocked_reason, conference_started_at, conference_ended_at, meet_space_name, import_attempts FROM enquadre_events WHERE id = $1`, [id])).rows[0];
  const trail = async (id: string, like = '%') =>
    (await admin.query(`SELECT kind, outcome, reason, ref FROM enquadre_event_trail WHERE event_id = $1 AND kind LIKE $2 ORDER BY at, kind`, [id, like])).rows as
      Array<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, unknown> | null }>;
  const logLines = (msg: string) =>
    logs.output().split('\n').filter((l) => l.includes(`"message":"${msg}"`)).map((l) => JSON.parse(l) as { eventId?: string; appointmentId?: string; reason?: string });
  const msgFor = (msg: string, ids: string[]) => logLines(msg).filter((l) => l.eventId && ids.includes(l.eventId));
  const conferencia = (inicioMinAgo: number, fimMinAgo: number | null, name = 'conferenceRecords/c1') => ({
    name, startTime: new Date(clock.getTime() - inicioMinAgo * MIN), endTime: fimMinAgo === null ? null : new Date(clock.getTime() - fimMinAgo * MIN),
  });

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM enquadre_event_documents WHERE event_id IN (SELECT id FROM enquadre_events WHERE job_posting_id = $1)`, [postingId]);
    await admin.query(`DELETE FROM enquadre_events WHERE job_posting_id = $1`, [postingId]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    env.setAll({ USE_MOCK_AUTH: 'true', DATABASE_URL, INTERNAL_TOKEN_SECRET: SECRET });
    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1,'Ficticia',$2,'AR',true) RETURNING id`,
      [`e2e-052-pc-${RUN}`, `Sobrenomeunico${RUN}`],
    );
    patientId = pat.rows[0].id;
    const post = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number)
       VALUES ($1,$2,'SEARCHING',false,'AR',true,$3) RETURNING id`,
      [POSTING_TITLE, patientId, 800000 + Math.floor(Math.random() * 90000)],
    );
    postingId = post.rows[0].id;

    fake = new FakeMeetConference();
    logs = capturingLogger();

    app = await montarAppDeFamilia({
      montarRotas: async ({ app: express }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const pool = DatabaseConnection.getInstance().getPool();
        const { AdmissionPostCallJob: Job } = await import('../../src/modules/matching/application/AdmissionPostCallJob');
        const { EnquadrePostCallRepository } = await import('../../src/modules/matching/infrastructure/EnquadrePostCallRepository');
        const { EnquadreEventTrailRepository } = await import('../../src/modules/matching/infrastructure/EnquadreEventTrailRepository');
        const { registerEnquadreInternalJobRoutes, ENQUADRE_POST_CALL_NAMING } = await import('../../src/bootstrap/registerEnquadreInternalJobRoutes');
        job = new Job({
          repo: new EnquadrePostCallRepository(pool), meet: fake, events: new EnquadreEventTrailRepository(pool),
          naming: ENQUADRE_POST_CALL_NAMING, db: pool, log: logs.log, now: () => clock,
        });
        // a rota REAL (wiring de produção), com a mesma Meet dublê e o relógio de verdade
        registerEnquadreInternalJobRoutes(express, { db: pool, meet: fake });
      },
    });
  }, 60000);

  beforeEach(async () => {
    clock = new Date();
    fake.reset();
    await limpar();
  });

  afterAll(async () => {
    if (postingId) {
      await limpar();
      await admin.query(`DELETE FROM job_postings WHERE id = $1`, [postingId]);
    }
    if (patientId) await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    env.restaurar();
  });

  // ── A ────────────────────────────────────────────────────────────────────────────────────────────
  it('A: a call terminou → conference_ended_at = o MAIOR endTime, início = o MENOR, import_status=pending (busca da transcrição), espaço guardado, trilha com os ids; rodar 2× não muda nada', async () => {
    const id = await ev({ startedMinAgo: 120 });
    const t0 = new Date(clock.getTime() - 118 * MIN);
    const t1 = new Date(clock.getTime() - 70 * MIN);
    fake.setRecords(MEET_CODE, [
      { name: 'conferenceRecords/p1', startTime: new Date(t0.getTime() - 10 * MIN), endTime: t0 },
      { name: 'conferenceRecords/p2', startTime: new Date(t0.getTime() + 4 * MIN), endTime: t1 },
    ]);
    const s1 = await job.runOnce(clock);
    expect(s1.ended).toBeGreaterThanOrEqual(1);
    const after = await row(id);
    expect(after).toMatchObject({ status: 'open', import_status: 'pending', blocked_reason: null, meet_space_name: `spaces/${MEET_CODE}` });
    expect(new Date(after.conference_ended_at).toISOString()).toBe(t1.toISOString());
    expect(new Date(after.conference_started_at).toISOString()).toBe(new Date(t0.getTime() - 10 * MIN).toISOString());
    const fim = await trail(id, 'conference_ended');
    expect(fim).toHaveLength(1);
    expect(fim[0]).toMatchObject({ outcome: 'ended' });
    expect(fim[0].ref).toMatchObject({ parts: 2, conferenceRecords: 'conferenceRecords/p1,conferenceRecords/p2' });
    expect(await trail(id, 'conference_started')).toHaveLength(1);
    // nomes de log do enquadre, com o id do EVENTO; nenhum `admission.*` nem `appointmentId`
    expect(msgFor('enquadre.conference_ended', [id])).toHaveLength(1);
    expect(logs.output()).not.toMatch(/"message":"admission\./);
    expect(logs.output()).not.toMatch(/"appointmentId"/);

    const chamadas = fake.listCalls.length;
    await job.runOnce(clock); // `pending` sai da fila: mesma linha, mesma trilha, zero chamadas novas
    expect(await row(id)).toEqual(after);
    expect(await trail(id, 'conference_ended')).toEqual(fim);
    expect(fake.listCalls.length).toBe(chamadas);
  });

  it('A: conferência ainda ABERTA → espera: só o INÍCIO é gravado; nenhuma mudança de estado', async () => {
    const id = await ev({ startedMinAgo: 40, meetSpace: `spaces/${MEET_CODE}` });
    fake.setRecords(MEET_CODE, [conferencia(38, null)]);
    const s = await job.runOnce(clock);
    expect(s.waiting).toBeGreaterThanOrEqual(1);
    expect(fake.listCalls).toContain(`spaces/${MEET_CODE}`);
    const r = await row(id);
    expect(r).toMatchObject({ import_status: null, conference_ended_at: null });
    expect(new Date(r.conference_started_at).toISOString()).toBe(new Date(clock.getTime() - 38 * MIN).toISOString());
    expect((await trail(id)).map((e) => e.kind)).toEqual(['conference_started']);
  });

  // ── B ────────────────────────────────────────────────────────────────────────────────────────────
  it('B: ninguém entrou até starts_at + 1 h → import_status=no_show (o status do evento NÃO muda), trilha e alarme; a transcrição nem é buscada; 2ª execução não repete', async () => {
    const id = await ev({ startedMinAgo: 61, meetSpace: `spaces/${MEET_CODE}` });
    const s = await job.runOnce(clock);
    expect(s.noShow).toBeGreaterThanOrEqual(1);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'open', import_status: 'no_show', conference_ended_at: null, blocked_reason: null });
    expect(await trail(id)).toMatchObject([{ kind: 'no_show', outcome: 'no_show', reason: 'no_conference_record' }]);
    expect(msgFor('enquadre.no_show', [id])).toHaveLength(1);
    await job.runOnce(clock);
    expect(await row(id)).toEqual(r);
    expect(await trail(id)).toHaveLength(1);
    expect(msgFor('enquadre.no_show', [id])).toHaveLength(1);
  });

  it('B (limite): lista vazia a 59 min do início ainda ESPERA — não vira no_show nem pending', async () => {
    const id = await ev({ startedMinAgo: 59, meetSpace: `spaces/${MEET_CODE}` });
    const antes = await row(id);
    await job.runOnce(clock);
    expect(await row(id)).toEqual(antes);
    expect(await trail(id)).toEqual([]);
  });

  // ── C ────────────────────────────────────────────────────────────────────────────────────────────
  it('C: Meet recusa o escopo → blocked com blocked_reason=meet_scope_missing (NUNCA no_show), 1 evento na trilha, alarme a cada execução; ao liberar → pending e o motivo SOME', async () => {
    fake.scopeMissing();
    const id = await ev({ startedMinAgo: 90 });
    const s1 = await job.runOnce(clock);
    expect(s1.blocked).toBeGreaterThanOrEqual(1);
    expect(s1.errors).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'open', import_status: 'blocked', blocked_reason: 'meet_scope_missing' });
    expect(await trail(id)).toMatchObject([{ kind: 'import_blocked', outcome: 'blocked', reason: 'meet_scope_missing' }]);
    await job.runOnce(clock);
    expect(await trail(id)).toHaveLength(1);
    expect(msgFor('enquadre.import_blocked', [id])).toHaveLength(2);

    fake.failWith(null);
    fake.setRecords(MEET_CODE, [conferencia(88, 60)]);
    await job.runOnce(clock);
    expect(await row(id)).toMatchObject({ import_status: 'pending', blocked_reason: null });
    expect((await trail(id)).map((e) => [e.kind, e.reason])).toEqual([['import_blocked', 'meet_scope_missing'], ['conference_ended', 'unblocked'], ['conference_started', null]]);
  });

  it('C: sem link do Meet → blocked reason=no_meet_link (o Meet nem é perguntado); falha de rede (transitória) não prova nada: estado e trilha intactos', async () => {
    const idSemLink = await ev({ startedMinAgo: 90, meetLink: null });
    const idRede = await ev({ startedMinAgo: 90 });
    fake.transient('http_503');
    const antes = await row(idRede);
    const s = await job.runOnce(clock);
    expect(s.transient).toBeGreaterThanOrEqual(1);
    expect(await row(idRede)).toEqual(antes);
    expect(await trail(idRede)).toEqual([]);
    expect(await row(idSemLink)).toMatchObject({ import_status: 'blocked', blocked_reason: 'no_meet_link' });
    expect(await trail(idSemLink)).toMatchObject([{ kind: 'import_blocked', reason: 'no_meet_link' }]);
  });

  // ── D ────────────────────────────────────────────────────────────────────────────────────────────
  it('D: entram na fila evento open E closed; ficam fora cancelado, futuro e fim há mais de 72 h (o Meet nem é consultado por eles)', async () => {
    const aberto = await ev({ startedMinAgo: 120 });
    const encerrado = await ev({ startedMinAgo: 120, status: 'closed' });
    const cancelado = await ev({ startedMinAgo: 120, status: 'cancelled' });
    const futuro = await ev({ startedMinAgo: -300 });
    const velho = await ev({ startedMinAgo: 73 * 60 + 30 });
    fake.setRecords(MEET_CODE, [conferencia(118, 100)]);
    await job.runOnce(clock);
    expect((await row(aberto)).import_status).toBe('pending');
    expect((await row(encerrado)).import_status).toBe('pending');
    for (const id of [cancelado, futuro, velho]) {
      expect((await row(id)).import_status).toBeNull();
      expect(await trail(id)).toEqual([]);
    }
  });

  // ── E ────────────────────────────────────────────────────────────────────────────────────────────
  it('E: SKIP LOCKED — duas execuções SOBREPOSTAS (Meet lenta) processam o evento UMA vez: 1 evento na trilha, a outra conta skippedLocked', async () => {
    const id = await ev({ startedMinAgo: 120 });
    fake.setRecords(MEET_CODE, [conferencia(118, 100)]);
    fake.delayMs = 400;
    const [a, b] = await Promise.all([job.runOnce(clock), job.runOnce(clock)]);
    expect(a.ended + b.ended).toBe(1);
    expect(a.skippedLocked + b.skippedLocked).toBeGreaterThanOrEqual(1);
    expect(await trail(id, 'conference_ended')).toHaveLength(1);
    expect(await trail(id, 'conference_started')).toHaveLength(1);
    expect((await row(id)).import_status).toBe('pending');
  });

  // ── F ────────────────────────────────────────────────────────────────────────────────────────────
  it('F: o lote é do ENQUADRE (LIMIT do repositório): com lote 2 e 5 eventos prontos, cada rodada pega no máximo 2 e em 3 rodadas todos saem da fila', async () => {
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { AdmissionPostCallJob: Job } = await import('../../src/modules/matching/application/AdmissionPostCallJob');
    const { EnquadrePostCallRepository } = await import('../../src/modules/matching/infrastructure/EnquadrePostCallRepository');
    const { EnquadreEventTrailRepository } = await import('../../src/modules/matching/infrastructure/EnquadreEventTrailRepository');
    const { ENQUADRE_POST_CALL_NAMING } = await import('../../src/bootstrap/registerEnquadreInternalJobRoutes');
    const { ENQUADRE_POST_CALL_BATCH } = await import('../../src/modules/matching/domain/enquadreJobConfig');
    const pool = DatabaseConnection.getInstance().getPool();
    const pequeno = new Job({
      repo: new EnquadrePostCallRepository(pool, 2), meet: fake, events: new EnquadreEventTrailRepository(pool),
      naming: ENQUADRE_POST_CALL_NAMING, db: pool, log: logs.log, now: () => clock,
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await ev({ startedMinAgo: 120 + i }));
    fake.setRecords(MEET_CODE, [conferencia(118, 100)]);

    const porRodada: number[] = [];
    for (let r = 0; r < 3; r += 1) porRodada.push((await pequeno.runOnce(clock)).candidates);
    expect(porRodada.every((n) => n <= 2)).toBe(true);
    expect(porRodada[0]).toBe(2);
    for (const id of ids) expect((await row(id)).import_status).toBe('pending');
    expect(ENQUADRE_POST_CALL_BATCH).toBe(100); // o valor próprio do enquadre (a admissão usa 200 e não compartilha a constante)
  });

  // ── G ────────────────────────────────────────────────────────────────────────────────────────────
  it('G: a trilha é append-only — UPDATE e DELETE de uma linha viva FALHAM com o erro do trigger; a cascata do evento apaga', async () => {
    const id = await ev({ startedMinAgo: 61, meetSpace: `spaces/${MEET_CODE}` });
    await job.runOnce(clock);
    expect(await trail(id)).toHaveLength(1);
    await expect(admin.query(`UPDATE enquadre_event_trail SET kind = 'x' WHERE event_id = $1`, [id])).rejects.toThrow(/enquadre_event_trail_imutavel: a trilha não se edita/);
    await expect(admin.query(`DELETE FROM enquadre_event_trail WHERE event_id = $1`, [id])).rejects.toThrow(/enquadre_event_trail_imutavel: a trilha não se apaga/);
    expect(await trail(id)).toHaveLength(1);
    await admin.query(`DELETE FROM enquadre_events WHERE id = $1`, [id]); // o evento-mãe some → a trilha vai junto (cascata)
    expect((await admin.query(`SELECT count(*)::int AS n FROM enquadre_event_trail WHERE event_id = $1`, [id])).rows[0].n).toBe(0);
  });

  // ── H ────────────────────────────────────────────────────────────────────────────────────────────
  it('H: a rota interna POST /api/internal/jobs/enquadre-post-call exige X-Internal-Secret (sem ele: 401/403) e, com ele, roda o job e devolve só contagens', async () => {
    const id = await ev({ startedMinAgo: 120 });
    fake.setRecords(MEET_CODE, [conferencia(118, 100)]);
    const negado = await fetch(`${app.url}/api/internal/jobs/enquadre-post-call`, { method: 'POST' });
    expect([401, 403]).toContain(negado.status);
    expect((await row(id)).import_status).toBeNull();
    const ok = await fetch(`${app.url}/api/internal/jobs/enquadre-post-call`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; data: { ended: number; candidates: number } };
    expect(body.success).toBe(true);
    expect(body.data.ended).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.data).sort()).toEqual(expect.arrayContaining(['candidates', 'ended', 'noShow', 'blocked']));
    expect((await row(id)).import_status).toBe('pending');
  });

  // ── I ────────────────────────────────────────────────────────────────────────────────────────────
  it('I: esquema da 521 — motivo só com blocked; transcrição (caminho+sha) nasce junta; presença e método coerentes; 1 documento por evento', async () => {
    const id = await ev({ startedMinAgo: 120 });
    await expect(admin.query(`UPDATE enquadre_events SET blocked_reason = 'x_y' WHERE id = $1`, [id])).rejects.toThrow(/enquadre_events_blocked_reason_check/);
    await expect(admin.query(`UPDATE enquadre_events SET transcript_object_path = 'AR/enquadre/x/transcricao-a.txt' WHERE id = $1`, [id])).rejects.toThrow(/enquadre_events_transcript_pair/);
    await expect(admin.query(`UPDATE enquadre_events SET transcript_object_path = 'p', transcript_sha256 = 'zz' WHERE id = $1`, [id])).rejects.toThrow(/enquadre_events_transcript_pair/);
    await admin.query(`UPDATE enquadre_events SET transcript_object_path = 'AR/enquadre/x/transcricao-a.txt', transcript_sha256 = $2 WHERE id = $1`, [id, 'a'.repeat(64)]);

    const wk = await admin.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'cipher', 'cipher') RETURNING id`,
      [`enq052-pc-${RUN}`, `w.${RUN}@example.test`.toLowerCase()],
    );
    {
      const wid = wk.rows[0].id as string;
      const part = await admin.query(`INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid) VALUES ($1,$2,$3,'u') RETURNING id`, [id, postingId, wid]);
      await expect(admin.query(`UPDATE enquadre_event_participants SET attendance = 'talvez' WHERE id = $1`, [part.rows[0].id])).rejects.toThrow(/attendance_check/);
      await expect(admin.query(`UPDATE enquadre_event_participants SET attendance = 'absent', match_method = 'display_name_unique' WHERE id = $1`, [part.rows[0].id])).rejects.toThrow(/match_method_check/);
      await admin.query(`UPDATE enquadre_event_participants SET attendance = 'present', match_method = 'display_name_unique' WHERE id = $1`, [part.rows[0].id]);
      await admin.query(`DELETE FROM enquadre_event_participants WHERE id = $1`, [part.rows[0].id]);
      await admin.query(`DELETE FROM workers WHERE id = $1`, [wid]);
    }

    const { EnquadreSummaryDocumentRepository } = await import('../../src/modules/matching/infrastructure/EnquadreSummaryDocumentRepository');
    const repo = new EnquadreSummaryDocumentRepository();
    const p = { eventId: id, labelEncrypted: 'c1', filePathEncrypted: 'c2', originalNameEncrypted: 'c3', sizeBytes: 10, sha256: Buffer.alloc(32, 1), promptVersion: 'v1', createdByUid: 'system:enquadre-import' };
    expect(await repo.insert(p, admin)).not.toBeNull();
    expect(await repo.insert(p, admin)).toBeNull(); // 2ª importação: ON CONFLICT DO NOTHING
    expect((await admin.query(`SELECT count(*)::int AS n FROM enquadre_event_documents WHERE event_id = $1`, [id])).rows[0].n).toBe(1);
    await expect(admin.query(`DELETE FROM enquadre_events WHERE id = $1`, [id])).rejects.toThrow(/enquadre_event_documents/); // RESTRICT: o resumo não some calado
  });

  it('log e trilha levam só ids e contagens: nem o e-mail do responsável, nem o link do Meet, nem o nome da entrevistadora (com controle positivo: o log TEM o id do evento)', async () => {
    const id = await ev({ startedMinAgo: 120 });
    fake.setRecords(MEET_CODE, [conferencia(118, 100)]);
    await job.runOnce(clock);
    const visivel = `${JSON.stringify(await trail(id))}\n${logs.output()}`;
    expect(visivel).toContain(id); // controle positivo: a medição enxerga o log do evento
    for (const proibido of ['example.test', MEET_LINK, 'Entrevistadora Sintetica']) expect(visivel).not.toContain(proibido);
  });
});
