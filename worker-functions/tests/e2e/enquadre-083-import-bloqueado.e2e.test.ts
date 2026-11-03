/**
 * enquadre-083-import-bloqueado.e2e.test.ts — spec 083, Fase 2: o MESMO comportamento da admissão sobre `enquadre_events` /
 * `enquadre_event_trail` (`EnquadreImportRepository`, a cláusula SQL compartilhada). POSTGRES REAL; o vínculo é o REAL
 * (`TactiqLinkService`); só as fronteiras de terceiros são dublê (as mesmas fábricas da 052: Tactiq, cofre e Vertex em memória, PDF em
 * memória). Dados SINTÉTICOS. Relógio injetado, ancorado no `at` REAL do `import_blocked` (a trilha usa o `now()` do banco).
 *
 * CA-1 23 h de rodadas = 1 log, 1 evento, 0 chamadas externas · CA-2 a fila lista só em +24 h, +48 h e fim+72 h · CA-7 vínculo refeito
 * → importa; `blocked_reason` some (CHECK da 521) · + reabrir e bloquear de novo grava o motivo novo (2 transições).
 */
import { Pool } from 'pg';
import { TENANT_E2E } from './helpers/permissionFamilyHarness';
import { criarEscopoDeEnv } from './helpers/admissionHarnessKit';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import type { FakeAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import type { InMemoryTranscriptVault } from '../../src/modules/matching/infrastructure/doubles/InMemoryTranscriptVault';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { TactiqMeetingItem, TactiqTranscriptPage } from '../../src/modules/matching/application/ports/TactiqPorts';
import type { AdmissionImportService } from '../../src/modules/matching/application/AdmissionImportService';
import type { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import type { FastGate } from '../../src/modules/matching/application/AdmissionTranscriptReader';
import type { EnquadreImportSubject } from '../../src/modules/matching/infrastructure/EnquadreImportRepository';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
const MIN = 60_000;
const HOUR = 60 * MIN;
const FOLGA = 1_000; // 1 s: o `Date` perde os µs do `at` do banco
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('importação do enquadre bloqueada por motivo humano — transita uma vez, lembra e reabre (spec 083, F2)', () => {
  let admin: Pool;
  let mcp: FakeTactiqMcp;
  let oauth: FakeTactiqOAuth;
  let vertex: FakeAdmissionSummaryGenerator;
  let vault: InMemoryTranscriptVault;
  let service: AdmissionImportService<EnquadreImportSubject>;
  let link: TactiqLinkService;
  let repo: { listDueIds(now: Date): Promise<string[]> };
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  let postingId = '';
  let patientId = '';
  const hostUids: string[] = [];
  const env = criarEscopoDeEnv();

  interface Ev { id: string; code: string; host: string; token: string; refresh: string; start: Date; uid: string }

  /** Evento com o fim real já gravado (80 min atrás); por padrão SEM vínculo do Tactiq. */
  async function evento(): Promise<Ev> {
    seq += 1;
    const start = new Date(clock.getTime() - 120 * MIN);
    const host = `host${seq}.${RUN}@example.test`.toLowerCase();
    const uid = `imp083e-${seq}-${RUN}`;
    const code = `ENC-${(RUN + String(seq).padStart(3, '0')).slice(-6)}`;
    const { rows } = await admin.query(
      `INSERT INTO enquadre_events
         (job_posting_id, country, host_email, host_display_name, starts_at, ends_at, event_code, status, meet_link, created_by_uid, import_status, conference_ended_at)
       VALUES ($1,'AR',$2,'Entrevistadora Sintetica',$3,$4,$5,'open','https://meet.google.com/abc-defg-hij','enq083-uid','pending',$6) RETURNING id`,
      [postingId, host, start, new Date(start.getTime() + 30 * MIN), code, new Date(clock.getTime() - 80 * MIN)],
    );
    await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [uid, host, TENANT_E2E]);
    hostUids.push(uid);
    const refresh = `rt-imp083e-${seq}-${RUN}`;
    return { id: rows[0].id as string, code, host, token: `at-${refresh}`, refresh, start, uid };
  }

  /** O vínculo REAL: `startLink` + `completeLink` com o relógio do teste. */
  async function conectar(e: Ev): Promise<void> {
    await link.startLink({ uid: e.uid, email: e.host });
    const { state } = oauth.authorizeCalls[oauth.authorizeCalls.length - 1];
    await link.completeLink({ state, code: e.refresh });
  }

  const meeting = (e: Ev): TactiqMeetingItem => ({ id: `tq-${e.code}`, title: `${e.code} Encuadre`, createdAt: e.start.toISOString(), durationSeconds: 1800 });
  function ver(e: Ev, items: TactiqMeetingItem[]): void {
    mcp.meetingsByToken.set(e.token, items);
    const page: TactiqTranscriptPage = { page: 1, totalPages: 1, totalChars: 'um dois'.length, hasMore: false, entries: [{ text: 'um dois', speaker: 'Hablante', startSeconds: 0, endSeconds: 9 }] };
    for (const m of items) mcp.pagesByMeeting.set(m.id, [page]);
  }

  const trilha = async (id: string) =>
    (await admin.query(`SELECT kind, outcome, reason, ref FROM enquadre_event_trail WHERE event_id = $1 ORDER BY at, kind`, [id])).rows as
      Array<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, any> | null }>;
  const count = async (id: string, kind: string) => (await trilha(id)).filter((t) => t.kind === kind).length;
  const row = async (id: string) =>
    (await admin.query(`SELECT import_status, blocked_reason FROM enquadre_events WHERE id = $1`, [id])).rows[0] as { import_status: string; blocked_reason: string | null };
  const bloqueadoEm = async (id: string) =>
    (await admin.query(`SELECT at FROM enquadre_event_trail WHERE event_id = $1 AND kind = 'import_blocked' ORDER BY at DESC LIMIT 1`, [id])).rows[0].at as Date;
  const logLines = (msg: string, id: string) =>
    logs.output().split('\n').filter((l) => l.includes(`"message":"${msg}"`)).map((l) => JSON.parse(l) as Record<string, any>).filter((l) => l.eventId === id);
  const externas = () => ({
    token: oauth.refreshCalls.length,
    mcp: mcp.pingTokens.length + mcp.searchCalls.length + mcp.transcriptCalls.length,
    cofre: vault.putCalls.length,
    vertex: vertex.received.length,
  });
  const ZERO = { token: 0, mcp: 0, cofre: 0, vertex: 0 };
  const em = (base: Date, ms: number): Date => new Date(base.getTime() + ms + FOLGA);
  const listado = async (id: string, now: Date): Promise<boolean> => (await repo.listDueIds(now)).includes(id);

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM enquadre_event_documents WHERE event_id IN (SELECT id FROM enquadre_events WHERE job_posting_id = $1)`, [postingId]);
    await admin.query(`DELETE FROM enquadre_events WHERE job_posting_id = $1`, [postingId]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    env.setAll({ USE_MOCK_AUTH: 'true', DATABASE_URL, INTERNAL_TOKEN_SECRET: 'test-secret-for-e2e-only' });
    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1,'Ficticia',$2,'AR',true) RETURNING id`,
      [`e2e-083-enq-${RUN}`, `Sobrenomeunico${RUN}`],
    );
    patientId = pat.rows[0].id;
    const post = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number) VALUES ($1,$2,'SEARCHING',false,'AR',true,$3) RETURNING id`,
      [`ENQ083 import ${RUN}`, patientId, 820000 + Math.floor(Math.random() * 90000)],
    );
    postingId = post.rows[0].id;

    const { createAdmissionExternals } = await import('../../src/modules/matching/infrastructure/admissionExternals');
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp: () => { throw new Error('canal real'); } });
    oauth = new FakeTactiqOAuth();
    mcp = new FakeTactiqMcp();
    vertex = ext.enquadreSummary as FakeAdmissionSummaryGenerator;
    vault = ext.enquadreVault as InMemoryTranscriptVault;
    logs = capturingLogger();

    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { TactiqLinkService: LinkSvc } = await import('../../src/modules/matching/application/TactiqLinkService');
    const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
    const { EnquadreImportRepository } = await import('../../src/modules/matching/infrastructure/EnquadreImportRepository');
    const { StoreAdmissionSummaryDocument } = await import('../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument');
    const { createEnquadreImportService } = await import('../../src/bootstrap/registerEnquadreInternalJobRoutes');
    const pool = DatabaseConnection.getInstance().getPool();
    link = new LinkSvc({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log, now: () => clock });
    let pdfs = 0;
    const storage = { uploadBuffer: async (_b: Buffer, _ct: string, prefix?: string) => ({ objectPath: `${prefix}/${(pdfs += 1)}-${RUN}.pdf` }), delete: async () => undefined };
    const store = new StoreAdmissionSummaryDocument(undefined, undefined, () => storage as never);
    service = createEnquadreImportService(pool, { tokens: link, mcp, vault, summary: vertex, destination: { store }, log: logs.log, now: () => clock });
    repo = new EnquadreImportRepository(pool);
  }, 60000);

  beforeEach(async () => {
    clock = new Date();
    mcp.reset();
    vertex.reset();
    vault.objects.clear();
    vault.putCalls.length = 0;
    oauth.refreshCalls.length = 0;
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await admin.query(`DELETE FROM job_postings WHERE id = $1`, [postingId]).catch(() => undefined);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => undefined);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [hostUids]).catch(() => undefined);
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    env.restaurar();
  });

  it('CA-1: 23 h de rodadas de 15 min sobre um `no_link` → 1 log `enquadre.import_blocked`, 1 evento na trilha, 0 chamadas externas (inclusive no "roda agora")', async () => {
    const e = await evento();
    ver(e, [meeting(e)]);
    const fast: FastGate = { hold: () => false };

    expect((await service.runOnce(clock)).blocked).toBe(1);
    const t0 = await bloqueadoEm(e.id);
    let relistado = 0;
    for (let t = 15 * MIN; t <= 23 * HOUR; t += 15 * MIN) {
      const c = em(t0, t - FOLGA);
      if (await listado(e.id, c)) relistado += 1;
      await service.runOnce(c);
      if (t % HOUR === 0) expect(await service.importOne(e.id, c, fast)).toBe('blocked');
    }

    expect(relistado).toBe(0);
    expect(logLines('enquadre.import_blocked', e.id)).toEqual([expect.objectContaining({ reason: 'no_link' })]);
    expect(await count(e.id, 'import_blocked')).toBe(1);
    expect(await count(e.id, 'import_reminder')).toBe(0);
    expect(externas()).toEqual(ZERO);
    expect(await row(e.id)).toEqual({ import_status: 'blocked', blocked_reason: 'no_link' });
  });

  it('CA-2: a fila do enquadre lista o item só em +24 h, +48 h e fim+72 h; cada lembrete é evento + log `reminder:n`; no fim expira', async () => {
    const e = await evento();
    await service.runOnce(clock);
    const t0 = await bloqueadoEm(e.id);

    for (const ms of [15 * MIN, 12 * HOUR, 24 * HOUR - 2 * MIN]) expect(await listado(e.id, em(t0, ms))).toBe(false);
    expect(await listado(e.id, em(t0, 24 * HOUR))).toBe(true);
    await service.runOnce(em(t0, 24 * HOUR));
    expect(logLines('enquadre.import_blocked', e.id).filter((l) => l.reminder === 1)).toHaveLength(1);

    for (const ms of [24 * HOUR + 15 * MIN, 36 * HOUR, 48 * HOUR - 2 * MIN]) expect(await listado(e.id, em(t0, ms))).toBe(false);
    expect(await listado(e.id, em(t0, 48 * HOUR))).toBe(true);
    await service.runOnce(em(t0, 48 * HOUR));
    expect((await trilha(e.id)).filter((t) => t.kind === 'import_reminder').map((t) => t.ref)).toEqual([{ n: 1 }, { n: 2 }]);

    for (const ms of [48 * HOUR + 15 * MIN, 60 * HOUR, 70 * HOUR]) expect(await listado(e.id, em(t0, ms))).toBe(false);
    expect(await listado(e.id, em(t0, 70 * HOUR + 41 * MIN))).toBe(true);
    expect((await service.runOnce(em(t0, 70 * HOUR + 41 * MIN))).expired).toBe(1);
    expect(await row(e.id)).toEqual({ import_status: 'expired', blocked_reason: null }); // sai do blocked: o motivo some (CHECK da 521)
    expect(await count(e.id, 'import_expired')).toBe(1);
    expect(await listado(e.id, em(t0, 72 * HOUR))).toBe(false);
    expect(await count(e.id, 'import_blocked')).toBe(1);
    expect(externas()).toEqual(ZERO);
  });

  it('CA-7: vínculo refeito → reabre (`waiting`, sem `blocked_reason`), importa na rodada seguinte, 0 re-bloqueios e nenhum lembrete depois', async () => {
    const e = await evento();
    await service.runOnce(clock);
    const b1 = await bloqueadoEm(e.id);
    expect(await row(e.id)).toEqual({ import_status: 'blocked', blocked_reason: 'no_link' });

    clock = em(b1, 1 * HOUR);
    await conectar(e);
    ver(e, [meeting(e)]);
    expect(await listado(e.id, clock)).toBe(true);
    clock = em(b1, 2 * HOUR);
    expect((await service.runOnce(clock)).done).toBe(1);
    expect(await row(e.id)).toEqual({ import_status: 'done', blocked_reason: null });
    expect((await trilha(e.id)).map((t) => t.kind)).toEqual(['import_blocked', 'import_reopened', 'import_matched', 'transcript_vaulted', 'summary_saved']);

    for (const h of [24, 48, 71]) {
      expect(await listado(e.id, em(b1, h * HOUR))).toBe(false);
      await service.runOnce(em(b1, h * HOUR));
    }
    expect(await count(e.id, 'import_reminder')).toBe(0);
    expect(await count(e.id, 'import_blocked')).toBe(1);
    expect(logLines('enquadre.import_blocked', e.id)).toHaveLength(1);
  });

  it('reabrir e bloquear de NOVO (`wrong_account`): `blocked_reason` passa de `no_link` a `wrong_account` (o CHECK da 521 aceita), 2 transições e o contador recomeça', async () => {
    const e = await evento();
    await service.runOnce(clock);
    const b1 = await bloqueadoEm(e.id);
    await service.runOnce(em(b1, 24 * HOUR));
    expect(await count(e.id, 'import_reminder')).toBe(1);

    clock = em(b1, 25 * HOUR);
    await conectar(e);
    ver(e, []); // a conta conectada não enxerga a reunião
    clock = em(b1, 26 * HOUR);
    expect((await service.runOnce(clock)).wrongAccount).toBe(1);

    expect((await trilha(e.id)).map((t) => [t.kind, t.reason])).toEqual([
      ['import_blocked', 'no_link'], ['import_reminder', 'no_link'], ['import_reopened', 'link_changed'], ['import_blocked', 'wrong_account'],
    ]);
    expect(await row(e.id)).toEqual({ import_status: 'blocked', blocked_reason: 'wrong_account' });
    const b2 = await bloqueadoEm(e.id);
    expect(await listado(e.id, em(b2, 23 * HOUR))).toBe(false);
    expect(await listado(e.id, em(b2, 24 * HOUR))).toBe(true);
  });
});
