/**
 * enquadre-083-aviso-import-bloqueado.e2e.test.ts — spec 083, Fase 3: o aviso no sino da importação bloqueada do ENQUADRE (mesmo
 * `ImportBlockNotifier`, `kind: 'enquadre'`, ligado por `createEnquadreImportService`). POSTGRES REAL; vínculo e publisher REAIS; só as
 * fronteiras de terceiros são dublê. Dados SINTÉTICOS. Relógio injetado, ancorado no `at` REAL do `import_blocked`.
 *
 * CA-3 host: blocked · reminder · reminder · expired, nenhum quinto · CA-5 gestão: EXATAMENTE 1 `will_be_lost` (48 h) · CA-8 publisher que
 * lança desfaz o estado · CA-9 gestão sem usuário: não lança · CA-10 linha gravada com as chaves do contrato e `patient_id` nulo.
 */
import { Pool } from 'pg';
import { TENANT_E2E } from './helpers/permissionFamilyHarness';
import { criarEscopoDeEnv } from './helpers/admissionHarnessKit';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import type { FakeAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import type { InMemoryTranscriptVault } from '../../src/modules/matching/infrastructure/doubles/InMemoryTranscriptVault';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { AdmissionImportService } from '../../src/modules/matching/application/AdmissionImportService';
import type { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import type { EnquadreImportSubject } from '../../src/modules/matching/infrastructure/EnquadreImportRepository';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
const MIN = 60_000;
const HOUR = 60 * MIN;
const FOLGA = 1_000;
const SUPERVISOR_ENV = 'ADMISSION_IMPORT_SUPERVISOR_EMAILS';
const KEYS_HOST = ['audience', 'deadlineAt', 'kind', 'meetingAt', 'reason', 'stage'];

describe('aviso no sino da importação bloqueada — host e gestão (spec 083, F3, enquadre)', () => {
  let admin: Pool;
  let mcp: FakeTactiqMcp;
  let oauth: FakeTactiqOAuth;
  let vertex: FakeAdmissionSummaryGenerator;
  let vault: InMemoryTranscriptVault;
  let service: AdmissionImportService<EnquadreImportSubject>;
  let build: (publisher?: unknown) => AdmissionImportService<EnquadreImportSubject>;
  let link: TactiqLinkService;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  let postingId = '';
  let patientId = '';
  const uids: string[] = [];
  const hostEmails: string[] = [];
  const env = criarEscopoDeEnv();

  interface Ev { id: string; code: string; host: string; uid: string; ended: Date; start: Date }

  async function user(email: string): Promise<string> {
    const uid = `av083e-${(seq += 1)}-${RUN}`;
    await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [uid, email, TENANT_E2E]);
    uids.push(uid);
    return uid;
  }

  async function evento(o: { endedAgo?: number } = {}): Promise<Ev> {
    seq += 1;
    const ended = new Date(clock.getTime() - (o.endedAgo ?? 80 * MIN));
    const start = new Date(ended.getTime() - 40 * MIN);
    const host = `host${seq}.${RUN}@example.test`;
    hostEmails.push(host);
    const code = `ENC-${(RUN + String(seq).padStart(3, '0')).toUpperCase().slice(-6)}`;
    const { rows } = await admin.query(
      `INSERT INTO enquadre_events
         (job_posting_id, country, host_email, host_display_name, starts_at, ends_at, event_code, status, meet_link, created_by_uid, import_status, conference_ended_at)
       VALUES ($1,'AR',$2,'Entrevistadora Sintetica',$3,$4,$5,'open','https://meet.google.com/abc-defg-hij','enq083-uid','pending',$6) RETURNING id`,
      [postingId, host, start, new Date(start.getTime() + 30 * MIN), code, ended],
    );
    const uid = await user(host);
    await admin.query(`INSERT INTO interview_hosts (email, display_name, country, countries) VALUES ($1,'Entrevistadora Sintetica','AR','{AR}') ON CONFLICT (email) DO NOTHING`, [host]);
    return { id: rows[0].id as string, code, host, uid, ended, start };
  }

  const sino = async (uid: string) =>
    (await admin.query(
      `SELECT e.payload, e.patient_id, e.actor_uid FROM notifications n JOIN notification_events e ON e.id = n.event_id
        WHERE n.recipient_uid = $1 AND e.type_code = 'ADMISSION_IMPORT_BLOCKED' ORDER BY e.created_at, e.id`, [uid])).rows as
      Array<{ payload: Record<string, any>; patient_id: string | null; actor_uid: string }>;
  const stages = async (uid: string): Promise<string[]> => (await sino(uid)).map((s) => s.payload.stage);
  const estado = async (id: string) => (await admin.query(`SELECT import_status FROM enquadre_events WHERE id = $1`, [id])).rows[0].import_status as string;
  const bloqueadoEm = async (id: string) =>
    (await admin.query(`SELECT at FROM enquadre_event_trail WHERE event_id = $1 AND kind = 'import_blocked' ORDER BY at DESC LIMIT 1`, [id])).rows[0].at as Date;
  const countTrail = async (id: string, kind: string) => (await admin.query(`SELECT count(*)::int n FROM enquadre_event_trail WHERE event_id = $1 AND kind = $2`, [id, kind])).rows[0].n as number;
  const em = (base: Date, ms: number): Date => new Date(base.getTime() + ms + FOLGA);
  const throwingPublisher = { publishAdmissionImportBlocked: async () => { throw new Error('sino indisponível'); } };

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    env.setAll({ USE_MOCK_AUTH: 'true', DATABASE_URL, INTERNAL_TOKEN_SECRET: 'test-secret-for-e2e-only' });
    const pat = await admin.query(`INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1,'Ficticia',$2,'AR',true) RETURNING id`, [`e2e-083-enqav-${RUN}`, `Sobrenomeunico${RUN}`]);
    patientId = pat.rows[0].id;
    const post = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number) VALUES ($1,$2,'SEARCHING',false,'AR',true,$3) RETURNING id`,
      [`ENQ083 aviso ${RUN}`, patientId, 830000 + Math.floor(Math.random() * 90000)],
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
    const { ImportNoticeRepository } = await import('../../src/modules/matching/infrastructure/ImportNoticeRepository');
    const { ImportBlockNotifier } = await import('../../src/modules/matching/application/ImportBlockNotifier');
    const { SystemNotificationPublisher } = await import('../../src/modules/inapp-notification/application/SystemNotificationPublisher');
    const { StoreAdmissionSummaryDocument } = await import('../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument');
    const { createEnquadreImportService } = await import('../../src/bootstrap/registerEnquadreInternalJobRoutes');
    const pool = DatabaseConnection.getInstance().getPool();
    link = new LinkSvc({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log, now: () => clock });
    const storage = { uploadBuffer: async () => ({ objectPath: `083e/${RUN}.pdf` }), delete: async () => undefined };
    const store = new StoreAdmissionSummaryDocument(undefined, undefined, () => storage as never);
    build = (publisher) => createEnquadreImportService(pool, {
      tokens: link, mcp, vault, summary: vertex, destination: { store }, log: logs.log, now: () => clock,
      notices: new ImportBlockNotifier({
        kind: 'enquadre', prefix: 'enquadre', publisher: (publisher ?? new SystemNotificationPublisher()) as never, recipients: new ImportNoticeRepository(pool), log: logs.log,
      }),
    });
    service = build();
  }, 60000);

  beforeEach(() => {
    clock = new Date();
    mcp.reset();
    vertex.reset();
    vault.objects.clear();
    vault.putCalls.length = 0;
    oauth.refreshCalls.length = 0;
    env.set(SUPERVISOR_ENV, undefined);
  });

  afterAll(async () => {
    const ev = (await admin.query(`SELECT event_id FROM notifications WHERE recipient_uid = ANY($1)`, [uids])).rows.map((r) => r.event_id);
    await admin.query(`DELETE FROM notifications WHERE recipient_uid = ANY($1)`, [uids]);
    await admin.query(`DELETE FROM notification_events WHERE id = ANY($1)`, [ev]);
    await admin.query(`DELETE FROM enquadre_event_documents WHERE event_id IN (SELECT id FROM enquadre_events WHERE job_posting_id = $1)`, [postingId]);
    await admin.query(`DELETE FROM enquadre_events WHERE job_posting_id = $1`, [postingId]);
    await admin.query(`DELETE FROM interview_hosts WHERE email = ANY($1)`, [hostEmails]);
    await admin.query(`DELETE FROM job_postings WHERE id = $1`, [postingId]).catch(() => undefined);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => undefined);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]).catch(() => undefined);
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    env.restaurar();
  });

  it('CA-3 + CA-5 + CA-10: host recebe blocked/reminder/reminder/expired (nenhum quinto); a gestão recebe EXATAMENTE 1 will_be_lost (48 h); linha fechada com kind enquadre', async () => {
    const sup = await user(`gestao.${RUN}@example.test`);
    env.set(SUPERVISOR_ENV, `gestao.${RUN}@example.test`);
    const e = await evento();
    await service.importOne(e.id, clock);
    const t0 = await bloqueadoEm(e.id);
    expect(await stages(e.uid)).toEqual(['blocked']);
    expect(await stages(sup)).toEqual([]);
    await service.importOne(e.id, em(t0, 24 * HOUR));
    expect(await stages(e.uid)).toEqual(['blocked', 'reminder']);
    expect(await stages(sup)).toEqual([]);
    await service.importOne(e.id, em(t0, 48 * HOUR));
    expect(await stages(e.uid)).toEqual(['blocked', 'reminder', 'reminder']);
    expect(await stages(sup)).toEqual(['will_be_lost']);
    await service.importOne(e.id, em(t0, 70 * HOUR + 41 * MIN));
    expect(await estado(e.id)).toBe('expired');
    for (const h of [71, 90]) await service.importOne(e.id, em(t0, h * HOUR));
    expect(await stages(e.uid)).toEqual(['blocked', 'reminder', 'reminder', 'expired']);
    expect(await stages(sup)).toEqual(['will_be_lost']);

    const [primeiro] = await sino(e.uid);
    expect(Object.keys(primeiro.payload).sort()).toEqual(KEYS_HOST);
    expect(primeiro.payload).toMatchObject({ kind: 'enquadre', reason: 'no_link', audience: 'host', meetingAt: e.start.toISOString(), deadlineAt: new Date(e.ended.getTime() + 72 * HOUR).toISOString() });
    const [gestao] = await sino(sup);
    expect(Object.keys(gestao.payload).sort()).toEqual([...KEYS_HOST, 'hostName'].sort());
    expect(gestao.payload.hostName).toBe('Entrevistadora Sintetica');
    for (const s of [...(await sino(e.uid)), gestao]) {
      expect(s.patient_id).toBeNull();
      expect(s.actor_uid).toBe('system:admission');
      for (const proibido of [e.code, e.id, 'Ficticia', `Sobrenomeunico${RUN}`, e.host]) expect(JSON.stringify(s.payload).toLowerCase()).not.toContain(proibido.toLowerCase());
    }
  });

  it('CA-8: publisher que lança DESFAZ o bloqueio do enquadre (estado `pending`, 0 evento na trilha, 0 sino)', async () => {
    const e = await evento();
    await expect(build(throwingPublisher).importOne(e.id, clock)).rejects.toThrow('sino indisponível');
    expect(await estado(e.id)).toBe('pending');
    expect(await countTrail(e.id, 'import_blocked')).toBe(0);
    expect(await stages(e.uid)).toEqual([]);
  });

  it('CA-9: gestão sem usuário ativo → host avisado, 0 sino para a gestão, o passo NÃO lança, nenhum e-mail no log', async () => {
    env.set(SUPERVISOR_ENV, `fantasma.${RUN}@example.test`);
    const e = await evento({ endedAgo: 50 * HOUR }); // nenhum lembrete cabe: a cópia da gestão sai no aviso inicial
    expect(await service.importOne(e.id, clock)).toBe('blocked');
    expect(await stages(e.uid)).toEqual(['blocked']);
    expect(logs.output()).toContain('enquadre.import_notice.no_recipient');
    expect(logs.output()).not.toContain('fantasma');
  });
});
