/**
 * admission-083-import-bloqueado.e2e.test.ts — spec 083, Fase 2: o bloqueio que SÓ uma pessoa resolve (`no_link`/`wrong_account`)
 * transita UMA vez, sai da fila de 15 min, volta nos lembretes (24 h/48 h) e na expiração (fim + 72 h) e reabre quando o vínculo é
 * refeito. POSTGRES REAL; o vínculo é o REAL (`TactiqLinkService`, `startLink`/`completeLink`); só as fronteiras de terceiros são dublê
 * (Tactiq, cofre em memória, Vertex, armazenamento do PDF em memória). Nada toca Tactiq, Vertex, Google nem bucket. Dados SINTÉTICOS.
 *
 * Relógio: o `now` é injetado e anda em passos de 15 min a partir do instante REAL do `import_blocked` (a trilha grava `at` com o
 * `now()` do banco: o relógio do teste se ancora nele, com 1 s de folga contra os microssegundos que o `Date` perde).
 *
 * CA-1 23 h de rodadas = 1 log, 1 evento, 0 chamadas externas · CA-2 a fila lista só nos instantes certos · CA-4 lembrete = evento +
 * log `reminder:n`, 0 chamadas · CA-6 vínculo refeito reabre; bloquear de novo = 2ª transição e o contador recomeça · CA-7 vínculo
 * refeito → importa na rodada seguinte, sem re-bloqueio nem lembrete depois.
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

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now().toString(36);
const MIN = 60_000;
const HOUR = 60 * MIN;
const FOLGA = 1_000; // 1 s: o `Date` perde os µs do `at` do banco
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('importação bloqueada por motivo humano — transita uma vez, lembra e reabre (spec 083, F2)', () => {
  let admin: Pool;
  let mcp: FakeTactiqMcp;
  let oauth: FakeTactiqOAuth;
  let vertex: FakeAdmissionSummaryGenerator;
  let vault: InMemoryTranscriptVault;
  let service: AdmissionImportService;
  let link: TactiqLinkService;
  let repo: { listDueIds(now: Date): Promise<string[]> };
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  let patientId = '';
  const hostUids: string[] = [];
  const env = criarEscopoDeEnv();

  interface Appt { id: string; code: string; host: string; token: string; refresh: string; start: Date; uid: string }

  /** Reunião com fim real já gravado (80 min atrás); por padrão SEM vínculo (é o caso do bloqueio). */
  async function appt(o: { link?: 'none' | 'linked' } = {}): Promise<Appt> {
    seq += 1;
    const start = new Date(clock.getTime() - 120 * MIN);
    const endedAt = new Date(clock.getTime() - 80 * MIN);
    const host = `op${seq}.${RUN}@example.test`;
    const uid = `imp083-${seq}-${RUN}`;
    const code = `ADM-${(RUN + String(seq).padStart(3, '0')).toUpperCase().slice(-6)}`;
    const { rows } = await admin.query(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
          created_at, conference_ended_at, import_status)
       VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,'booked','https://meet.google.com/abc-defg-hij',$5,$6,$7,'pending') RETURNING id`,
      [patientId, host, start, new Date(start.getTime() + 30 * MIN), code, new Date(start.getTime() - 5 * HOUR), endedAt],
    );
    await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [uid, host, TENANT_E2E]);
    hostUids.push(uid);
    const refresh = `rt-imp083-${seq}-${RUN}`;
    if (o.link === 'linked') {
      const ins = await admin.query(
        `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, last_notified_status, created_at) VALUES ($1,$2,'linked',$3,'linked',$4) RETURNING id`,
        [host, uid, clock, new Date(clock.getTime() - 24 * HOUR)], /* o vínculo precisa ser ANTERIOR ao fim da reunião: reunião terminada antes do 1º vínculo só expira (não vira wrong_account) */
      );
      await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1,$2)`, [ins.rows[0].id, b64(refresh)]);
    }
    return { id: rows[0].id as string, code, host, token: `at-${refresh}`, refresh, start, uid };
  }

  /** O vínculo REAL: `startLink` + `completeLink` com o relógio do teste. */
  async function conectar(a: Appt): Promise<void> {
    await link.startLink({ uid: a.uid, email: a.host });
    const { state } = oauth.authorizeCalls[oauth.authorizeCalls.length - 1];
    await link.completeLink({ state, code: a.refresh });
    // o vínculo precisa ser ANTERIOR ao fim da reunião: reunião terminada antes do 1º vínculo só expira (não vira wrong_account)
    await admin.query(`UPDATE tactiq_links SET created_at = $2 WHERE lower(host_email) = lower($1)`, [a.host, new Date(a.start.getTime() - 24 * HOUR)]);
  }

  const meeting = (a: Appt): TactiqMeetingItem => ({ id: `tq-${a.code}`, title: `${a.code} Admisión`, createdAt: a.start.toISOString(), durationSeconds: 1800 });
  function ver(a: Appt, items: TactiqMeetingItem[]): void {
    mcp.meetingsByToken.set(a.token, items);
    const page: TactiqTranscriptPage = { page: 1, totalPages: 1, totalChars: 'um dois'.length, hasMore: false, entries: [{ text: 'um dois', speaker: 'Operadora', startSeconds: 0, endSeconds: 9 }] };
    for (const m of items) mcp.pagesByMeeting.set(m.id, [page]);
  }

  const events = async (id: string) =>
    (await admin.query(`SELECT kind, outcome, reason, ref FROM admission_events WHERE appointment_id = $1 ORDER BY at, kind`, [id])).rows as
      Array<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, any> | null }>;
  const count = async (id: string, kind: string) => (await events(id)).filter((e) => e.kind === kind).length;
  const estado = async (id: string) => (await admin.query(`SELECT import_status FROM admission_appointments WHERE id = $1`, [id])).rows[0].import_status as string;
  /** O instante REAL do último `import_blocked` (ancora o relógio injetado). */
  const bloqueadoEm = async (id: string) =>
    (await admin.query(`SELECT at FROM admission_events WHERE appointment_id = $1 AND kind = 'import_blocked' ORDER BY at DESC LIMIT 1`, [id])).rows[0].at as Date;
  const logLines = (msg: string, id: string) =>
    logs.output().split('\n').filter((l) => l.includes(`"message":"${msg}"`)).map((l) => JSON.parse(l) as Record<string, any>).filter((l) => l.appointmentId === id);
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
    await admin.query(`DELETE FROM patient_documents WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    env.setAll({ USE_MOCK_AUTH: 'true', DATABASE_URL, INTERNAL_TOKEN_SECRET: 'test-secret-for-e2e-only' });
    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
       VALUES ($1,'Carlota',$2,'AR',false,true,'+5491155550183') RETURNING id`,
      [`e2e-083-imp-${RUN}`, `Sintetica${RUN}`],
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
    const { StoreAdmissionSummaryDocument } = await import('../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument');
    const pool = DatabaseConnection.getInstance().getPool();
    link = new LinkSvc({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log, now: () => clock });
    // o PDF vai a um armazenamento em memória na costura de `StoreAdmissionSummaryDocument` (nada toca bucket)
    let pdfs = 0;
    const storage = { uploadBuffer: async (_b: Buffer, _ct: string, prefix?: string) => ({ objectPath: `${prefix}/${(pdfs += 1)}-${RUN}.pdf` }), delete: async () => undefined };
    const importRepo = new AdmissionImportRepository(pool);
    repo = importRepo;
    service = new Svc({
      repo: importRepo, events: new AdmissionEventRepository(pool), tokens: link, mcp, vault, summary: vertex, db: pool, log: logs.log, now: () => clock,
      documents: new StoreAdmissionSummaryDocument(undefined, undefined, () => storage as never),
    });
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
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => undefined);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [hostUids]).catch(() => undefined);
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    env.restaurar();
  });

  it('CA-1: 23 h de rodadas de 15 min sobre um `no_link` → 1 log `import_blocked`, 1 evento, 0 chamadas a token/MCP/cofre/Vertex (inclusive no "roda agora")', async () => {
    const a = await appt();
    ver(a, [meeting(a)]);
    const fast: FastGate = { hold: () => false };

    expect((await service.runOnce(clock)).blocked).toBe(1);
    const t0 = await bloqueadoEm(a.id);
    let relistado = 0;
    for (let t = 15 * MIN; t <= 23 * HOUR; t += 15 * MIN) {
      const c = em(t0, t - FOLGA);
      if (await listado(a.id, c)) relistado += 1;
      await service.runOnce(c);
      if (t % HOUR === 0) expect(await service.importOne(a.id, c, fast)).toBe('blocked'); // o botão "roda agora" vai ao leitor e bloqueia calado
    }

    expect(relistado).toBe(0); // 92 rodadas, a fila nunca o devolveu
    expect(logLines('admission.import_blocked', a.id)).toEqual([expect.objectContaining({ reason: 'no_link' })]);
    expect(await count(a.id, 'import_blocked')).toBe(1);
    expect(await count(a.id, 'import_reminder')).toBe(0);
    expect(externas()).toEqual(ZERO);
    expect(await estado(a.id)).toBe('blocked');
  });

  it('CA-2 + CA-4: a fila lista o item só em +24 h, +48 h e fim+72 h; cada lembrete = evento `import_reminder` + log `reminder:n`, 0 chamadas externas; no fim expira', async () => {
    const a = await appt();
    ver(a, [meeting(a)]);
    await service.runOnce(clock);
    const t0 = await bloqueadoEm(a.id);

    // antes do 1º lembrete: fora; no instante: dentro
    for (const ms of [15 * MIN, 12 * HOUR, 24 * HOUR - 2 * MIN]) expect(await listado(a.id, em(t0, ms))).toBe(false);
    expect(await listado(a.id, em(t0, 24 * HOUR))).toBe(true);
    expect((await service.runOnce(em(t0, 24 * HOUR))).blocked).toBe(1);
    expect((await events(a.id)).filter((e) => e.kind === 'import_reminder')).toEqual([expect.objectContaining({ reason: 'no_link', ref: { n: 1 } })]);
    expect(logLines('admission.import_blocked', a.id).filter((l) => l.reminder === 1)).toEqual([expect.objectContaining({ reason: 'no_link' })]);

    // depois do 1º: fora até o instante do 2º
    for (const ms of [24 * HOUR + 15 * MIN, 36 * HOUR, 48 * HOUR - 2 * MIN]) expect(await listado(a.id, em(t0, ms))).toBe(false);
    expect(await listado(a.id, em(t0, 48 * HOUR))).toBe(true);
    await service.runOnce(em(t0, 48 * HOUR));
    expect((await events(a.id)).filter((e) => e.kind === 'import_reminder').map((e) => e.ref)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(logLines('admission.import_blocked', a.id).filter((l) => l.reminder === 2)).toHaveLength(1);

    // no máximo 2 lembretes; fora até o fim da janela de 72 h (fim real = 80 min antes do início do teste)
    for (const ms of [48 * HOUR + 15 * MIN, 60 * HOUR, 70 * HOUR]) expect(await listado(a.id, em(t0, ms))).toBe(false);
    expect(await listado(a.id, em(t0, 70 * HOUR + 41 * MIN))).toBe(true);
    expect((await service.runOnce(em(t0, 70 * HOUR + 41 * MIN))).expired).toBe(1);
    expect(await estado(a.id)).toBe('expired');
    expect(await count(a.id, 'import_expired')).toBe(1);
    expect(await listado(a.id, em(t0, 72 * HOUR))).toBe(false); // expirado sai da fila

    expect(logLines('admission.import_blocked', a.id).filter((l) => l.reminder === undefined)).toHaveLength(1); // a transição
    expect(await count(a.id, 'import_reminder')).toBe(2);
    expect(await count(a.id, 'import_blocked')).toBe(1);
    expect(externas()).toEqual(ZERO); // lembrete e expiração sem vínculo nunca falam com token, MCP, cofre nem Vertex
  });

  it('CA-6: vínculo refeito (completeLink REAL) reabre; bloquear de NOVO por `wrong_account` = 2ª transição (evento + log) e o contador de lembretes recomeça', async () => {
    const a = await appt();
    await service.runOnce(clock);
    const b1 = await bloqueadoEm(a.id);
    await service.runOnce(em(b1, 24 * HOUR)); // 1 lembrete antes de conectar
    expect(await count(a.id, 'import_reminder')).toBe(1);

    clock = em(b1, 25 * HOUR);
    await conectar(a); // a conta conectada NÃO enxerga a reunião
    ver(a, []);
    expect(await listado(a.id, clock)).toBe(true); // vínculo `linked` mais novo que o bloqueio: volta à fila
    clock = em(b1, 26 * HOUR);
    expect((await service.runOnce(clock)).wrongAccount).toBe(1);

    expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([
      ['import_blocked', 'no_link'], ['import_reminder', 'no_link'], ['import_reopened', 'link_changed'], ['import_blocked', 'wrong_account'],
    ]);
    expect(await estado(a.id)).toBe('blocked');
    const transicoes = logLines('admission.import_blocked', a.id).filter((l) => l.reminder === undefined);
    expect(transicoes.map((l) => l.reason)).toEqual(['no_link', 'wrong_account']); // 2 transições, 2 logs

    // o contador recomeça: conta só depois do 2º `import_blocked`
    const b2 = await bloqueadoEm(a.id);
    expect(await listado(a.id, em(b2, 23 * HOUR))).toBe(false);
    expect(await listado(a.id, em(b2, 24 * HOUR))).toBe(true);
    await service.runOnce(em(b2, 24 * HOUR));
    expect((await events(a.id)).filter((e) => e.kind === 'import_reminder').map((e) => [e.reason, e.ref])).toEqual([['no_link', { n: 1 }], ['wrong_account', { n: 1 }]]);
  });

  it('CA-7: vínculo refeito → importa na rodada seguinte, 0 re-bloqueios, e nenhum lembrete depois', async () => {
    const a = await appt();
    await service.runOnce(clock);
    const b1 = await bloqueadoEm(a.id);
    expect(externas()).toEqual(ZERO);

    clock = em(b1, 1 * HOUR);
    await conectar(a);
    ver(a, [meeting(a)]);
    clock = em(b1, 2 * HOUR);
    expect((await service.runOnce(clock)).done).toBe(1);
    expect(await estado(a.id)).toBe('done');
    expect((await events(a.id)).map((e) => e.kind)).toEqual(['import_blocked', 'import_reopened', 'import_matched', 'transcript_vaulted', 'summary_saved']);

    // dias depois: nada volta (nem lembrete, nem novo bloqueio)
    for (const h of [24, 48, 71]) {
      expect(await listado(a.id, em(b1, h * HOUR))).toBe(false);
      await service.runOnce(em(b1, h * HOUR));
    }
    expect(await count(a.id, 'import_reminder')).toBe(0);
    expect(await count(a.id, 'import_blocked')).toBe(1);
    expect(logLines('admission.import_blocked', a.id)).toHaveLength(1);
    expect(vertex.received).toHaveLength(1);
  });
});
