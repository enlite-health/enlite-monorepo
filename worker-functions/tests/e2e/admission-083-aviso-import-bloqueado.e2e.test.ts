/**
 * admission-083-aviso-import-bloqueado.e2e.test.ts — spec 083, Fase 3: o AVISO NO SINO da importação bloqueada (admissão). POSTGRES REAL;
 * o vínculo e o publisher do sino são os REAIS (`TactiqLinkService`, `SystemNotificationPublisher`, `ImportBlockNotifier`); só as
 * fronteiras de terceiros são dublê. Dados SINTÉTICOS. Relógio injetado, ancorado no `at` REAL do `import_blocked`.
 *
 * CA-3 host: 0 h blocked · 24 h reminder · 48 h reminder · fim+72 h expired, nenhum quinto · CA-5 gestão: EXATAMENTE 1 `will_be_lost`
 * (no de 48 h), env A × env B, host = gestão, bloqueio tardio, nenhum lembrete cabe · CA-8 publisher que lança desfaz o estado; expiração
 * por `not_found` não avisa · CA-9 gestão sem usuário / env vazio ou mal formado / host sem usuário: o job não cai · CA-10 linha gravada.
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

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const FOLGA = 1_000; // 1 s: o `Date` perde os µs do `at` do banco
const SUPERVISOR_ENV = 'ADMISSION_IMPORT_SUPERVISOR_EMAILS';
const PACIENTE = 'Carlota';
const KEYS_HOST = ['audience', 'deadlineAt', 'kind', 'meetingAt', 'reason', 'stage'];

describe('aviso no sino da importação bloqueada — host e gestão (spec 083, F3, admissão)', () => {
  let admin: Pool;
  let mcp: FakeTactiqMcp;
  let oauth: FakeTactiqOAuth;
  let vertex: FakeAdmissionSummaryGenerator;
  let vault: InMemoryTranscriptVault;
  let service: AdmissionImportService;
  let build: (publisher?: unknown) => AdmissionImportService;
  let link: TactiqLinkService;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  let patientId = '';
  const uids: string[] = [];
  const hostEmails: string[] = [];
  const env = criarEscopoDeEnv();

  interface Appt { id: string; code: string; host: string; uid: string; ended: Date }
  interface Sino { stage: string; audience: string; payload: Record<string, any>; patientId: string | null; actor: string }

  async function user(email: string): Promise<string> {
    const uid = `av083-${(seq += 1)}-${RUN}`;
    await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [uid, email, TENANT_E2E]);
    uids.push(uid);
    return uid;
  }

  /** Reunião sem vínculo, com o fim real `endedAgo` atrás (padrão 80 min). `semUsuario`: o host não tem conta ativa. */
  async function appt(o: { endedAgo?: number; semUsuario?: boolean; vinculo?: boolean; email?: string } = {}): Promise<Appt> {
    seq += 1;
    const ended = new Date(clock.getTime() - (o.endedAgo ?? 80 * MIN));
    const start = new Date(ended.getTime() - 40 * MIN);
    const host = o.email ?? `host${seq}.${RUN}@example.test`;
    hostEmails.push(host);
    const code = `ADM-${(RUN + String(seq).padStart(3, '0')).toUpperCase().slice(-6)}`;
    const { rows } = await admin.query(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code, created_at, conference_ended_at, import_status)
       VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,'booked','https://meet.google.com/abc-defg-hij',$5,$6,$7,'pending') RETURNING id`,
      [patientId, host, start, new Date(start.getTime() + 30 * MIN), code, new Date(start.getTime() - 5 * HOUR), ended],
    );
    const uid = o.semUsuario ? '' : await user(host);
    await admin.query(`INSERT INTO interview_hosts (email, display_name, country, countries) VALUES ($1,'Operadora Sintetica','AR','{AR}') ON CONFLICT (email) DO NOTHING`, [host]);
    if (o.vinculo) {
      const ins = await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, last_notified_status) VALUES ($1,$2,'linked',$3,'linked') RETURNING id`, [host, uid || 'x', clock]);
      await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1,$2)`, [ins.rows[0].id, Buffer.from(`rt-${seq}`).toString('base64')]);
    }
    return { id: rows[0].id as string, code, host, uid, ended };
  }

  const sino = async (uid: string): Promise<Sino[]> =>
    (await admin.query(
      `SELECT e.payload, e.patient_id, e.actor_uid FROM notifications n JOIN notification_events e ON e.id = n.event_id
        WHERE n.recipient_uid = $1 AND e.type_code = 'ADMISSION_IMPORT_BLOCKED' ORDER BY e.created_at, e.id`, [uid])).rows
      .map((r) => ({ stage: r.payload.stage, audience: r.payload.audience, payload: r.payload, patientId: r.patient_id, actor: r.actor_uid }));
  const stages = async (uid: string): Promise<string[]> => (await sino(uid)).map((s) => s.stage);
  const estado = async (id: string) => (await admin.query(`SELECT import_status FROM admission_appointments WHERE id = $1`, [id])).rows[0].import_status as string;
  const countEv = async (id: string, kind: string) => (await admin.query(`SELECT count(*)::int n FROM admission_events WHERE appointment_id = $1 AND kind = $2`, [id, kind])).rows[0].n as number;
  const bloqueadoEm = async (id: string) =>
    (await admin.query(`SELECT at FROM admission_events WHERE appointment_id = $1 AND kind = 'import_blocked' ORDER BY at DESC LIMIT 1`, [id])).rows[0].at as Date;
  const em = (base: Date, ms: number): Date => new Date(base.getTime() + ms + FOLGA);
  const warnsSemDestinatario = (audience: string) =>
    logs.output().split('\n').filter((l) => l.includes('"message":"admission.import_notice.no_recipient"')).map((l) => JSON.parse(l) as Record<string, any>).filter((l) => l.audience === audience);
  const throwingPublisher = { publishAdmissionImportBlocked: async () => { throw new Error('sino indisponível'); } };

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    env.setAll({ USE_MOCK_AUTH: 'true', DATABASE_URL, INTERNAL_TOKEN_SECRET: 'test-secret-for-e2e-only' });
    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
       VALUES ($1,$2,$3,'AR',false,true,'+5491155550184') RETURNING id`,
      [`e2e-083-aviso-${RUN}`, PACIENTE, `Sintetica${RUN}`],
    );
    patientId = pat.rows[0].id;
    const { createAdmissionExternals } = await import('../../src/modules/matching/infrastructure/admissionExternals');
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp: () => { throw new Error('canal real'); } });
    oauth = new FakeTactiqOAuth();
    mcp = new FakeTactiqMcp();
    vertex = ext.summary as FakeAdmissionSummaryGenerator;
    vault = ext.vault as InMemoryTranscriptVault;
    logs = capturingLogger();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { TactiqLinkService: LinkSvc } = await import('../../src/modules/matching/application/TactiqLinkService');
    const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
    const { AdmissionImportService: Svc } = await import('../../src/modules/matching/application/AdmissionImportService');
    const { AdmissionImportRepository } = await import('../../src/modules/matching/infrastructure/AdmissionImportRepository');
    const { AdmissionEventRepository } = await import('../../src/modules/matching/infrastructure/AdmissionEventRepository');
    const { ImportNoticeRepository } = await import('../../src/modules/matching/infrastructure/ImportNoticeRepository');
    const { ImportBlockNotifier } = await import('../../src/modules/matching/application/ImportBlockNotifier');
    const { SystemNotificationPublisher } = await import('../../src/modules/inapp-notification/application/SystemNotificationPublisher');
    const { StoreAdmissionSummaryDocument } = await import('../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument');
    const pool = DatabaseConnection.getInstance().getPool();
    link = new LinkSvc({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log, now: () => clock });
    const storage = { uploadBuffer: async () => ({ objectPath: `083/${RUN}.pdf` }), delete: async () => undefined };
    build = (publisher) => new Svc({
      repo: new AdmissionImportRepository(pool), events: new AdmissionEventRepository(pool), tokens: link, mcp, vault, summary: vertex, db: pool, log: logs.log, now: () => clock,
      documents: new StoreAdmissionSummaryDocument(undefined, undefined, () => storage as never),
      notices: new ImportBlockNotifier({
        kind: 'admission', prefix: 'admission', publisher: (publisher ?? new SystemNotificationPublisher()) as never,
        recipients: new ImportNoticeRepository(pool), log: logs.log,
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
    await admin.query(`DELETE FROM patient_documents WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM interview_hosts WHERE email = ANY($1)`, [hostEmails]);
    await admin.query(`DELETE FROM tactiq_links WHERE host_email = ANY($1)`, [hostEmails]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => undefined);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]).catch(() => undefined);
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    env.restaurar();
  });

  it('CA-3 + CA-5 + CA-10: host recebe blocked/reminder/reminder/expired (nenhum quinto); a gestão recebe EXATAMENTE 1 will_be_lost, no de 48 h; linha gravada fechada', async () => {
    const sup = await user(`gestao.${RUN}@example.test`);
    env.set(SUPERVISOR_ENV, `GESTAO.${RUN}@example.test`); // caixa alta: normaliza
    const a = await appt();

    await service.importOne(a.id, clock);
    const t0 = await bloqueadoEm(a.id);
    expect(await stages(a.uid)).toEqual(['blocked']);
    expect(await stages(sup)).toEqual([]); // 0 h: a gestão NÃO recebe

    await service.importOne(a.id, em(t0, 24 * HOUR));
    expect(await stages(a.uid)).toEqual(['blocked', 'reminder']);
    expect(await stages(sup)).toEqual([]); // 24 h: nada para a gestão

    await service.importOne(a.id, em(t0, 48 * HOUR));
    expect(await stages(a.uid)).toEqual(['blocked', 'reminder', 'reminder']);
    expect(await stages(sup)).toEqual(['will_be_lost']); // 48 h: UM aviso

    await service.importOne(a.id, em(t0, 70 * HOUR + 41 * MIN));
    expect(await estado(a.id)).toBe('expired');
    expect(await stages(a.uid)).toEqual(['blocked', 'reminder', 'reminder', 'expired']);
    for (const h of [71, 80, 100]) await service.importOne(a.id, em(t0, h * HOUR));
    expect(await stages(a.uid)).toHaveLength(4); // nenhum quinto
    expect(await stages(sup)).toEqual(['will_be_lost']); // a gestão não recebe expired nem nada além do 1

    // CA-10: só as chaves do contrato; paciente nulo; ator do sistema; nada de paciente/código/id
    const [primeiro] = await sino(a.uid);
    expect(Object.keys(primeiro.payload).sort()).toEqual(KEYS_HOST);
    expect(primeiro.payload).toMatchObject({ kind: 'admission', reason: 'no_link', audience: 'host', meetingAt: expect.any(String) });
    expect(primeiro.payload.deadlineAt).toBe(new Date(a.ended.getTime() + 72 * HOUR).toISOString());
    const [gestao] = await sino(sup);
    expect(Object.keys(gestao.payload).sort()).toEqual([...KEYS_HOST, 'hostName'].sort());
    expect(gestao.payload.hostName).toBe('Operadora Sintetica');
    for (const s of [...(await sino(a.uid)), gestao]) {
      expect(s.patientId).toBeNull();
      expect(s.actor).toBe('system:admission');
      const txt = JSON.stringify(s.payload);
      for (const proibido of [a.code, a.id, PACIENTE, `Sintetica${RUN}`, a.host]) expect(txt).not.toContain(proibido);
    }
    expect((await sino(a.uid)).filter((s) => 'hostName' in s.payload)).toHaveLength(0); // nome só na cópia da gestão
  });

  it('CA-5: trocar o env troca o destinatário (env B → só o B recebe; o A não)', async () => {
    const supA = await user(`a.${RUN}@example.test`);
    const supB = await user(`b.${RUN}@example.test`);
    env.set(SUPERVISOR_ENV, `b.${RUN}@example.test`);
    const a = await appt();
    await service.importOne(a.id, clock);
    const t0 = await bloqueadoEm(a.id);
    await service.importOne(a.id, em(t0, 24 * HOUR));
    await service.importOne(a.id, em(t0, 48 * HOUR));
    expect(await stages(supB)).toEqual(['will_be_lost']);
    expect(await stages(supA)).toEqual([]);
  });

  it('CA-5: host = gestão (mesmo uid) → só a versão do host, nenhum aviso extra', async () => {
    const host = `dupla.${RUN}@example.test`;
    env.set(SUPERVISOR_ENV, host);
    const a = await appt({ email: host });
    await service.importOne(a.id, clock);
    const t0 = await bloqueadoEm(a.id);
    await service.importOne(a.id, em(t0, 24 * HOUR));
    await service.importOne(a.id, em(t0, 48 * HOUR));
    const s = await sino(a.uid);
    expect(s.map((x) => x.stage)).toEqual(['blocked', 'reminder', 'reminder']);
    expect(s.every((x) => x.audience === 'host')).toBe(true);
  });

  it('CA-5 bloqueio tardio: fim há 30 h → o lembrete 1 já é o último e leva a gestão; 0 no aviso inicial; 1 no total', async () => {
    const sup = await user(`tarde.${RUN}@example.test`);
    env.set(SUPERVISOR_ENV, `tarde.${RUN}@example.test`);
    const a = await appt({ endedAgo: 30 * HOUR });
    await service.importOne(a.id, clock);
    const t0 = await bloqueadoEm(a.id);
    expect(await stages(sup)).toEqual([]);
    await service.importOne(a.id, em(t0, 24 * HOUR));
    expect(await stages(a.uid)).toEqual(['blocked', 'reminder']);
    expect(await stages(sup)).toEqual(['will_be_lost']);
    await service.importOne(a.id, em(t0, 42 * HOUR + MIN)); // fim + 72 h
    expect(await stages(a.uid)).toEqual(['blocked', 'reminder', 'expired']);
    expect(await stages(sup)).toEqual(['will_be_lost']);
  });

  it('CA-5 nenhum lembrete cabe: fim há 50 h → o aviso inicial já leva a cópia da gestão (1 no total, mesmo depois de expirar)', async () => {
    const sup = await user(`nada.${RUN}@example.test`);
    env.set(SUPERVISOR_ENV, `nada.${RUN}@example.test`);
    const a = await appt({ endedAgo: 50 * HOUR });
    await service.importOne(a.id, clock);
    const t0 = await bloqueadoEm(a.id);
    expect(await stages(a.uid)).toEqual(['blocked']);
    expect(await stages(sup)).toEqual(['will_be_lost']);
    await service.importOne(a.id, em(t0, 23 * HOUR)); // passou de fim + 72 h
    expect(await stages(a.uid)).toEqual(['blocked', 'expired']);
    expect(await stages(sup)).toEqual(['will_be_lost']);
    expect(await countEv(a.id, 'import_reminder')).toBe(0);
  });

  it('CA-8: publisher que lança DESFAZ o bloqueio (estado `pending`, 0 evento, 0 sino) e o erro sobe ao job, que conta 1 `step_failed` e segue', async () => {
    const a = await appt();
    await expect(build(throwingPublisher).importOne(a.id, clock)).rejects.toThrow('sino indisponível'); // o job conta 1 step_failed e segue
    expect(await estado(a.id)).toBe('pending');
    expect(await countEv(a.id, 'import_blocked')).toBe(0);
    expect(await stages(a.uid)).toEqual([]);
    expect(await service.importOne(a.id, clock)).toBe('blocked'); // com o sino de volta, bloqueia normal
    expect(await stages(a.uid)).toEqual(['blocked']);
  });

  it('CA-8: publisher que lança na EXPIRAÇÃO desfaz o `expired` (segue blocked, 0 import_expired); depois avisa 1×', async () => {
    const a = await appt();
    await service.importOne(a.id, clock);
    const t0 = await bloqueadoEm(a.id);
    const fim = em(t0, 70 * HOUR + 41 * MIN);
    await expect(build(throwingPublisher).importOne(a.id, fim)).rejects.toThrow('sino indisponível');
    expect(await estado(a.id)).toBe('blocked');
    expect(await countEv(a.id, 'import_expired')).toBe(0);
    await service.importOne(a.id, fim);
    expect(await estado(a.id)).toBe('expired');
    expect((await stages(a.uid)).filter((s) => s === 'expired')).toHaveLength(1);
  });

  it('CA-8: expiração por `not_found` (conta certa, reunião não apareceu) NÃO avisa ninguém', async () => {
    const a = await appt({ endedAgo: 73 * HOUR, vinculo: true });
    mcp.meetingsByToken.set(`at-rt-${seq}`, []);
    expect(await service.importOne(a.id, clock)).toBe('expired');
    expect(await estado(a.id)).toBe('expired');
    expect((await admin.query(`SELECT reason FROM admission_events WHERE appointment_id = $1 AND kind = 'import_expired'`, [a.id])).rows).toEqual([{ reason: 'not_found' }]);
    expect(await stages(a.uid)).toEqual([]);
  });

  describe.each([
    ['gestão sem usuário ativo', (): string => `fantasma.${RUN}@example.test`],
    ['env vazio', (): string => ''],
    ['env mal formado', (): string => 'nao-e-um-email;outro lixo'],
  ])('CA-9 — %s', (_nome, valor) => {
    it('host avisado, sem sino para a gestão, `warn` sem e-mail e o passo NÃO lança (job sem `step_failed`)', async () => {
      env.set(SUPERVISOR_ENV, valor());
      const a = await appt({ endedAgo: 50 * HOUR }); // nenhum lembrete cabe: a cópia da gestão sai já no aviso inicial
      expect(await service.importOne(a.id, clock)).toBe('blocked'); // não lança: o job não conta step_failed
      expect(await stages(a.uid)).toEqual(['blocked']);
      expect((await admin.query(`SELECT count(*)::int n FROM notification_events e WHERE e.type_code = 'ADMISSION_IMPORT_BLOCKED' AND e.payload->>'audience' = 'supervisor' AND e.payload->>'meetingAt' = $1`, [new Date(a.ended.getTime() - 40 * MIN).toISOString()])).rows[0].n).toBe(0);
      expect(warnsSemDestinatario('supervisor').length).toBeGreaterThan(0);
      expect(logs.output()).not.toContain('fantasma');
      expect(logs.output()).not.toContain('nao-e-um-email');
    });
  });

  it('CA-9: host SEM usuário ativo → `warn`, o bloqueio segue (estado blocked), nada lançado', async () => {
    const a = await appt({ semUsuario: true });
    expect(await service.importOne(a.id, clock)).toBe('blocked');
    expect(await estado(a.id)).toBe('blocked');
    expect(warnsSemDestinatario('host').length).toBeGreaterThan(0);
  });
});
