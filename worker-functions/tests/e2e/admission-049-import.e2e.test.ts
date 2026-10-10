/**
 * admission-049-import.e2e.test.ts — spec 049, F6: a importação do Tactiq (MCP -> provas -> cofre -> Vertex -> PDF -> documento)
 * contra POSTGRES REAL e um COFRE/BUCKET REAIS EM EMULADOR (fake-gcs-server local — `GCS_EMULATOR_HOST`): o `GcsTranscriptVault`
 * de verdade escreve com `ifGenerationMatch=0` e o `StoreAdmissionSummaryDocument` de verdade sobe o PDF. Só as fronteiras de
 * terceiros são dublê: Tactiq (OAuth e MCP) e Vertex. Nada toca Tactiq, Vertex, Google nem bucket real. Dados SINTÉTICOS.
 *
 * Relógio: o `now` da importação é injetado; as reuniões nascem relativas a ele. O vínculo é o REAL (`TactiqLinkService`, KMS em
 * passthrough): o token do responsável vira `at-<refresh>` no dublê do OAuth, e é POR TOKEN que o dublê do MCP decide o que a
 * conta "enxerga" — é assim que "autor errado" é provado.
 *
 * A6-1 feliz · A6-2 anti-duplicata (2×, estado perdido, sobreposta) · A6-3 casamento · A6-4 conta errada · A6-5 integridade
 * A6-6 partes · A6-7 cofre recusa o 2º PUT · A6-8 log sem texto · A6-9 vínculo quebrado · estados expired/ambiguous/rejected.
 */
import { createHash } from 'crypto';
import { inflateSync } from 'zlib';
import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import { montarAppDeFamilia, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { TactiqUnauthorizedError, type TactiqMeetingItem, type TactiqTranscriptPage } from '../../src/modules/matching/application/ports/TactiqPorts';
import { AdmissionSummaryError } from '../../src/modules/matching/application/ports/AdmissionImportPorts';
import { VertexAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/VertexAdmissionSummaryGenerator';
import type { AdmissionImportService } from '../../src/modules/matching/application/AdmissionImportService';
import type { GcsTranscriptVault } from '../../src/modules/matching/infrastructure/GcsTranscriptVault';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const FAKE_GCS_URL = process.env.GCS_EMULATOR_HOST || 'http://localhost:54443';
const SECRET = 'test-secret-for-e2e-only';
const RUN = Date.now().toString(36);
const VAULT_BUCKET = `f049-vault-${RUN}`;
const DOCS_BUCKET = `f049-docs-${RUN}`;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Trechos SINTÉTICOS que NUNCA podem aparecer em log, trilha ou documento. */
const FRASE_CLINICA = 'FRASE-CLINICA-SINTETICA-ZETA';
const RESUMO = 'RESUMO-SINTETICO-OMEGA';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

/** Texto de todas as streams do PDF, já descomprimidas, + o texto hex que o pdf-lib usa em `drawText`. */
function pdfStreams(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [raw];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out.push(inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      /* stream não comprimida */
    }
  }
  return out.join('\n');
}
const hexOf = (s: string): string => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

describe('importação do Tactiq — banco real, cofre e bucket em emulador (spec 049, F6)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let storage: Storage;
  let mcp: FakeTactiqMcp;
  let oauth: FakeTactiqOAuth;
  let vertex: FakeAdmissionSummaryGenerator;
  let service: AdmissionImportService;
  let link: import('../../src/modules/matching/application/TactiqLinkService').TactiqLinkService;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  let patientId = '';
  const hostEmails: string[] = [];
  const hostUids: string[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const code = (): string => `ADM-${(RUN + String(seq).padStart(3, '0')).toUpperCase().slice(-6)}`;

  interface Appt { id: string; code: string; host: string; token: string; start: Date; uid: string }

  /** Reunião de admissão com o fim real JÁ gravado (a F5 fez isso) e, por padrão, o responsável com vínculo vivo. */
  async function appt(opts: {
    startedMinAgo?: number; endedMinAgo?: number; importStatus?: string | null; status?: string;
    link?: 'linked' | 'broken' | 'none'; withEnd?: boolean; user?: boolean;
  } = {}): Promise<Appt> {
    seq += 1;
    const start = new Date(clock.getTime() - (opts.startedMinAgo ?? 120) * MIN);
    const end = new Date(start.getTime() + 30 * MIN);
    const endedAt = opts.withEnd === false ? null : new Date(clock.getTime() - (opts.endedMinAgo ?? 80) * MIN);
    const host = `op${seq}.${RUN}@example.test`;
    const uid = `imp049-${seq}-${RUN}`;
    const c = code();
    const { rows } = await admin.query(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
          created_at, conference_ended_at, import_status)
       VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,$5,'https://meet.google.com/abc-defg-hij',$6,$7,$8,$9) RETURNING id`,
      [patientId, host, start, end, opts.status ?? 'booked', c, new Date(start.getTime() - 5 * HOUR), endedAt,
        opts.importStatus === undefined ? 'pending' : opts.importStatus],
    );
    hostEmails.push(host);
    const token = `rt-imp-${seq}-${RUN}`;
    if (opts.user !== false) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`,
        [uid, host, TENANT_E2E],
      );
      hostUids.push(uid);
    }
    const mode = opts.link ?? 'linked';
    if (mode !== 'none') {
      const ins = await admin.query(
        `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, last_notified_status)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [host, uid, mode, clock, mode === 'linked' ? 'linked' : null],
      );
      // `broken` também guarda o token (o teste diário não o apaga): só o ESTADO do vínculo pode impedir o uso dele.
      await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1,$2)`, [ins.rows[0].id, b64(token)]);
    }
    return { id: rows[0].id as string, code: c, host, token: `at-${token}`, start, uid };
  }

  const meeting = (a: Appt, id: string, o: { title?: string; offsetMin?: number; durationSec?: number } = {}): TactiqMeetingItem => ({
    id, title: o.title ?? `${a.code} Admisión`, createdAt: new Date(a.start.getTime() + (o.offsetMin ?? 0) * MIN).toISOString(),
    durationSeconds: o.durationSec ?? 1800,
  });

  /** Páginas coerentes (totalChars = soma dos textos). */
  function pages(texts: string[], perPage = 2): TactiqTranscriptPage[] {
    const total = texts.reduce((n, t) => n + t.length, 0);
    const chunks: string[][] = [];
    for (let i = 0; i < texts.length; i += perPage) chunks.push(texts.slice(i, i + perPage));
    return chunks.map((c, i) => ({
      page: i + 1, totalPages: chunks.length, totalChars: total, hasMore: i < chunks.length - 1,
      entries: c.map((t, j) => ({ text: t, speaker: 'Operadora', startSeconds: (i * perPage + j) * 10, endSeconds: (i * perPage + j) * 10 + 9 })),
    }));
  }
  function see(a: Appt, items: TactiqMeetingItem[], texts: Record<string, string[]> = {}): void {
    mcp.meetingsByToken.set(a.token, items);
    for (const m of items) mcp.pagesByMeeting.set(m.id, pages(texts[m.id] ?? [`${FRASE_CLINICA} um`, 'dois', 'tres']));
  }

  const row = async (id: string) =>
    (await admin.query(`SELECT status, import_status, import_attempts, conference_ended_at FROM admission_appointments WHERE id = $1`, [id])).rows[0];
  const docs = async (id: string) =>
    (await admin.query(`SELECT * FROM patient_documents WHERE source_appointment_id = $1`, [id])).rows as Array<Record<string, any>>;
  const events = async (id: string, like = '%') =>
    (await admin.query(`SELECT kind, outcome, reason, ref FROM admission_events WHERE appointment_id = $1 AND kind LIKE $2 ORDER BY at, kind`, [id, like])).rows as
      Array<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, any> | null }>;
  const kinds = async (id: string) => (await events(id)).map((e) => e.kind);
  const vaultFiles = async (id: string) => (await storage.bucket(VAULT_BUCKET).getFiles({ prefix: `AR/${id}/` }))[0];
  const docFiles = async () => (await storage.bucket(DOCS_BUCKET).getFiles({ prefix: 'patient-documents/' }))[0];
  const sino = async (uid: string) =>
    (await admin.query(
      `SELECT e.payload FROM notifications n JOIN notification_events e ON e.id = n.event_id WHERE n.recipient_uid = $1 AND e.type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED'`, [uid],
    )).rows as Array<{ payload: { reason: string } }>;
  const linkStatus = async (email: string) => (await admin.query(`SELECT status FROM tactiq_links WHERE lower(host_email) = lower($1)`, [email])).rows[0]?.status as string;
  const logLines = (msg: string) => logs.output().split('\n').filter((l) => l.includes(`"message":"${msg}"`)).map((l) => JSON.parse(l) as Record<string, any>);

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM patient_documents WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
  }

  async function createBucket(name: string): Promise<void> {
    const res = await fetch(`${FAKE_GCS_URL}/storage/v1/b?project=enlite-test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`fake-gcs: criar bucket ${name} -> ${res.status}`);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('INTERNAL_TOKEN_SECRET', SECRET);
    setEnv('GCS_EMULATOR_HOST', FAKE_GCS_URL);
    setEnv('GCP_PROJECT_ID', 'enlite-test');
    setEnv('PATIENT_DOCUMENTS_BUCKET', DOCS_BUCKET);
    setEnv('ADMISSION_TRANSCRIPT_VAULT_BUCKET', VAULT_BUCKET);
    storage = new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' });
    await createBucket(VAULT_BUCKET);
    await createBucket(DOCS_BUCKET);

    const { rows } = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
       VALUES ($1,'Carlota',$2,'AR',false,true,'+5491155550149') RETURNING id`,
      [`e2e-049-imp-${RUN}`, `Sintetica${RUN}`],
    );
    patientId = rows[0].id;

    mcp = new FakeTactiqMcp();
    oauth = new FakeTactiqOAuth();
    vertex = new FakeAdmissionSummaryGenerator();
    logs = capturingLogger();

    app = await montarAppDeFamilia({
      montarRotas: async ({ app: express }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
        const { internalAuthMiddleware } = await import('@modules/notification/interfaces/middleware/InternalAuthMiddleware');
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        const { AdmissionImportService: Svc } = await import('../../src/modules/matching/application/AdmissionImportService');
        const { AdmissionImportRepository } = await import('../../src/modules/matching/infrastructure/AdmissionImportRepository');
        const { AdmissionEventRepository } = await import('../../src/modules/matching/infrastructure/AdmissionEventRepository');
        const { GcsTranscriptVault: Vault } = await import('../../src/modules/matching/infrastructure/GcsTranscriptVault');
        const { AdmissionImportInternalController } = await import('../../src/modules/matching/interfaces/controllers/AdmissionImportInternalController');
        const { createAdmissionImportInternalRoutes } = await import('../../src/modules/matching/interfaces/routes/admissionImportRoutes');
        const pool = DatabaseConnection.getInstance().getPool();
        link = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log, now: () => clock });
        const vault: GcsTranscriptVault = new Vault({ env: process.env, client: new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' }) });
        service = new Svc({
          repo: new AdmissionImportRepository(pool), events: new AdmissionEventRepository(pool), tokens: link, mcp, vault,
          summary: vertex, db: pool, log: logs.log, now: () => clock,
        });
        express.use('/api/internal', systemContextMiddleware('job:admission-import'), internalAuthMiddleware,
          createAdmissionImportInternalRoutes(new AdmissionImportInternalController(service)));
      },
    });
  }, 90000);

  beforeEach(async () => {
    clock = new Date();
    mcp.reset();
    vertex.reset();
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [hostUids]).catch(() => undefined);
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── A6-1 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A6-1: reunião certa (código exato, janela, 1 candidata, soma bate) → 1 objeto no cofre, 1 documento `admission`, `done`, e o Vertex recebe a transcrição', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-1')]);
    vertex.summary = `${RESUMO}: ponto A.\nSegunda linha com acentos: señora, niño, ñandú.`;

    expect(await service.importOne(a.id, clock)).toBe('done');

    // a busca foi feita com o token DO RESPONSÁVEL, o código e a janela [início − 15 min, início + 60 min]
    expect(mcp.searchCalls).toEqual([{
      token: a.token, query: a.code,
      dateFrom: new Date(a.start.getTime() - 15 * MIN).toISOString(), dateTo: new Date(a.start.getTime() + 60 * MIN).toISOString(),
    }]);
    expect(await row(a.id)).toMatchObject({ import_status: 'done', status: 'booked' });

    const files = await vaultFiles(a.id);
    expect(files).toHaveLength(1);
    const [content] = await files[0].download();
    expect(content.toString('utf8')).toContain(FRASE_CLINICA); // a transcrição crua está NO COFRE
    const sha = createHash('sha256').update(content).digest('hex');
    expect(files[0].name).toBe(`AR/${a.id}/transcricao-${sha}.txt`);

    const d = await docs(a.id);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ origin: 'admission', patient_id: patientId, created_by_uid: 'system:admission-import', content_type: 'application/pdf', source_appointment_id: a.id });
    const dd = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' }).format(a.start);
    expect(unb64(d[0].label_encrypted)).toBe(`Resumen de admisión · ${dd}`);

    // o PDF: o RESUMO está nele; a TRANSCRIÇÃO CRUA não (ela só vai ao cofre e ao Vertex)
    const pdfFile = (await docFiles()).find((f) => f.name === unb64(d[0].file_path_encrypted));
    expect(pdfFile).toBeDefined();
    const [pdf] = await (pdfFile as NonNullable<typeof pdfFile>).download();
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(Buffer.from(d[0].sha256).toString('hex'));
    const text = pdfStreams(pdf);
    expect(text).toContain(hexOf(RESUMO));
    expect(text).not.toContain(hexOf(FRASE_CLINICA));
    expect(text).not.toContain(FRASE_CLINICA);

    // o Vertex recebeu a transcrição (1×); a trilha tem os 3 passos, em ordem, só com ids/hash
    expect(vertex.received).toHaveLength(1);
    expect(vertex.received[0]).toContain(FRASE_CLINICA);
    expect(await kinds(a.id)).toEqual(['import_matched', 'transcript_vaulted', 'summary_saved']);
    const ev = await events(a.id);
    expect(ev.find((e) => e.kind === 'transcript_vaulted')?.ref).toMatchObject({ object: files[0].name, sha256: sha, bytes: content.byteLength });
    expect(ev.find((e) => e.kind === 'summary_saved')?.ref).toMatchObject({ documentId: d[0].id, promptVersion: 'fake-v0' });
    expect(JSON.stringify(ev)).not.toContain(FRASE_CLINICA);
    expect(JSON.stringify(ev)).not.toContain(RESUMO);
  });

  // ── A6-2 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A6-2 (anti-duplicata §6): o job 2× / sobreposto → 1 documento e 1 objeto', () => {
    it('2 passadas seguidas: a 2ª é `already_done` (nem toca o Tactiq nem o Vertex)', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-2a')]);
      expect(await service.importOne(a.id, clock)).toBe('done');
      const searches = mcp.searchCalls.length;
      expect(await service.importOne(a.id, clock)).toBe('already_done');
      expect(mcp.searchCalls.length).toBe(searches);
      expect(vertex.received).toHaveLength(1);
      expect(await docs(a.id)).toHaveLength(1);
      expect(await vaultFiles(a.id)).toHaveLength(1);
    });

    it('estado `done` PERDIDO (a reunião volta a `pending`): as travas do cofre e do documento seguram — 1 documento, 1 objeto, mesma generation, 0 PDF órfão', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-2b')]);
      expect(await service.importOne(a.id, clock)).toBe('done');
      const [obj] = await vaultFiles(a.id);
      const generation = obj.metadata.generation;
      const pdfsBefore = (await docFiles()).length;

      await admin.query(`UPDATE admission_appointments SET import_status = 'pending' WHERE id = $1`, [a.id]);
      expect(await service.importOne(a.id, clock)).toBe('already_done');

      expect(await docs(a.id)).toHaveLength(1);
      const after = await vaultFiles(a.id);
      expect(after).toHaveLength(1);
      expect(after[0].metadata.generation).toBe(generation); // o cofre NÃO foi sobrescrito
      expect((await docFiles()).length).toBe(pdfsBefore); // o PDF da 2ª passada não ficou órfão no bucket
      expect(await row(a.id)).toMatchObject({ import_status: 'done' });
    });

    it('Vertex cai depois do cofre: o objeto fica, o estado fica `pending`; na tentativa seguinte o cofre responde 412 (`already_vaulted`) e nasce 1 documento', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-2c')]);
      vertex.failWith = new AdmissionSummaryError('vertex_failed');
      expect(await service.importOne(a.id, clock)).toBe('summary_failed');
      expect(await row(a.id)).toMatchObject({ import_status: 'pending' });
      expect(await docs(a.id)).toHaveLength(0);
      const [obj] = await vaultFiles(a.id);
      const generation = obj.metadata.generation;
      expect(await kinds(a.id)).toEqual(['import_matched', 'transcript_vaulted', 'summary_failed']);

      vertex.failWith = null;
      expect(await service.importOne(a.id, clock)).toBe('done');
      expect(await docs(a.id)).toHaveLength(1);
      const files = await vaultFiles(a.id);
      expect(files).toHaveLength(1);
      expect(files[0].metadata.generation).toBe(generation);
      // `transcript_vaulted` não se repete quando o objeto já estava lá
      expect((await events(a.id)).filter((e) => e.kind === 'transcript_vaulted')).toHaveLength(1);
    });

    it('H4 (a)+(b): SEM o Doc do prompt → 1 objeto no cofre, 0 documentos, `summary_failed prompt_missing`; depois de configurar, a próxima execução gera 1 documento e o cofre segue com 1 objeto (mesma geração)', async () => {
      // O gerador REAL (Vertex + provider do Doc são dublês): a ausência do Doc é provada no código de produção, não no dublê do teste.
      const env: Record<string, string | undefined> = { NODE_ENV: 'production' };
      const viaVertex = jest.fn(async () => ({ json: async () => ({ candidates: [{ content: { parts: [{ text: 'RESUMO-SINTETICO-H4' }] } }] }) }) as unknown as Response);
      const gen = new VertexAdmissionSummaryGenerator(env as NodeJS.ProcessEnv, {
        promptProvider: { getPrompt: async () => 'PROMPT-SINTETICO-DO-DOC' }, vertex: viaVertex as never,
        catalogs: { segmentLabels: async () => ['SEG-SINTETICO'], pathologyTypeLabels: async () => ['PAT-SINTETICA (99)'] },
      });
      const deps = (service as unknown as { deps: { summary: unknown } }).deps;
      const original = deps.summary;
      deps.summary = gen;
      try {
        const a = await appt();
        see(a, [meeting(a, 'tq-h4')]);

        expect(await service.importOne(a.id, clock)).toBe('summary_failed');
        expect(viaVertex).not.toHaveBeenCalled();
        expect(await docs(a.id)).toHaveLength(0);
        const [obj] = await vaultFiles(a.id);
        expect(await vaultFiles(a.id)).toHaveLength(1);
        expect(await row(a.id)).toMatchObject({ import_status: 'pending' });
        const failed = (await events(a.id)).filter((e) => e.kind === 'summary_failed');
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ reason: 'prompt_missing' });

        env.ADMISSION_SUMMARY_PROMPT_DOC_ID = 'doc-sintetico';
        expect(await service.importOne(a.id, clock)).toBe('done');
        expect(viaVertex).toHaveBeenCalledTimes(1);
        expect(await docs(a.id)).toHaveLength(1);
        const files = await vaultFiles(a.id);
        expect(files).toHaveLength(1);
        expect(files[0].metadata.generation).toBe(obj.metadata.generation); // o cofre NÃO foi regravado
        expect((await events(a.id)).filter((e) => e.kind === 'transcript_vaulted')).toHaveLength(1);
        const saved = (await events(a.id)).find((e) => e.kind === 'summary_saved');
        expect(saved?.ref).toMatchObject({ promptVersion: expect.stringMatching(/^sha256:[0-9a-f]{12}$/) });
      } finally {
        deps.summary = original;
      }
    });

    it('2 execuções SOBREPOSTAS (a 1ª segura o lock da reunião enquanto fala com o Tactiq e o Vertex): a outra pula; 1 documento, 1 objeto, 1 só busca no Tactiq', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-2d')]);
      let release: () => void = () => undefined;
      mcp.gate = new Promise<void>((r) => { release = r; });
      const failsafe = setTimeout(() => release(), 3000); // se a trava da linha faltar, a 2ª espera o gate: não pode travar o teste

      const first = service.importOne(a.id, clock);
      await new Promise((r) => setTimeout(r, 400)); // a 1ª já travou a linha e está parada no Tactiq
      const second = await service.importOne(a.id, clock);
      expect(second).toBe('skipped_locked');
      clearTimeout(failsafe);
      release();
      expect(await Promise.race([first, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('barreira: 1ª execução não terminou em 10 s')), 10_000))])).toBe('done');

      expect(mcp.searchCalls).toHaveLength(1);
      expect(vertex.received).toHaveLength(1);
      expect(await docs(a.id)).toHaveLength(1);
      expect(await vaultFiles(a.id)).toHaveLength(1);
    });
  });

  // ── A6-3 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A6-3 (§6): casamento — fora da janela / código parecido / 2 sobrepostas / duração 0 → 0 documentos e 0 objetos', () => {
    const nada = async (a: Appt): Promise<void> => {
      expect(await docs(a.id)).toHaveLength(0);
      expect(await vaultFiles(a.id)).toHaveLength(0);
      expect(vertex.received).toHaveLength(0);
      expect(mcp.transcriptCalls).toHaveLength(0);
    };

    it('código EXATO fora da janela de tempo → `rejected` (time_window), com o motivo na trilha', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-3a', { offsetMin: 180 })]);
      expect(await service.importOne(a.id, clock)).toBe('rejected');
      expect(await row(a.id)).toMatchObject({ import_status: 'rejected' });
      expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([['import_rejected', 'time_window']]);
      await nada(a);
    });

    it('código PARECIDO (o nosso é prefixo do título) → NÃO casa: `waiting` com motivo code_mismatch', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-3b', { title: `${a.code}Z Outra reunião` }), meeting(a, 'tq-3b2', { title: `X${a.code} Outra` })]);
      expect(await service.importOne(a.id, clock)).toBe('waiting');
      expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([['import_waiting', 'code_mismatch']]);
      await nada(a);
    });

    it('2 candidatas SOBREPOSTAS no tempo → `ambiguous`, nada é importado', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-3c1', { offsetMin: 0, durationSec: 1800 }), meeting(a, 'tq-3c2', { offsetMin: 10, durationSec: 1800 })]);
      expect(await service.importOne(a.id, clock)).toBe('ambiguous');
      expect(await row(a.id)).toMatchObject({ import_status: 'ambiguous' });
      expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([['import_ambiguous', 'overlap']]);
      await nada(a);
    });

    it('duração 0 → não é reunião de verdade: `rejected`', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-3d', { durationSec: 0 })]);
      expect(await service.importOne(a.id, clock)).toBe('rejected');
      await nada(a);
    });

    it('SEM conferenceRecord (sem fim real): a reunião nem é elegível — `runOnce` não a lista e `importOne` recusa; no_show idem', async () => {
      const semFim = await appt({ withEnd: false, importStatus: null });
      const noShow = await appt({ status: 'no_show', importStatus: 'no_show' });
      for (const x of [semFim, noShow]) see(x, [meeting(x, `tq-3e-${x.code}`)]);

      expect(await service.importOne(semFim.id, clock)).toBe('not_eligible');
      expect(await service.importOne(noShow.id, clock)).toBe('not_eligible');
      const summary = await service.runOnce(clock);
      expect(summary.candidates).toBeGreaterThanOrEqual(0);
      expect(mcp.searchCalls.filter((c) => c.token === semFim.token || c.token === noShow.token)).toHaveLength(0);
      await nada(semFim);
      await nada(noShow);
      expect(await row(semFim.id)).toMatchObject({ import_status: null });
      expect(await row(noShow.id)).toMatchObject({ import_status: 'no_show' });
    });

    it('10 min depois do fim real: antes disso não faz nada (`too_early`)', async () => {
      const a = await appt({ endedMinAgo: 5 });
      see(a, [meeting(a, 'tq-3f')]);
      expect(await service.importOne(a.id, clock)).toBe('too_early');
      expect(mcp.searchCalls).toHaveLength(0);
      await nada(a);
    });
  });

  // ── A6-4 e estados de espera ─────────────────────────────────────────────────────────────────────
  describe('autor errado / conta errada / espera / 72 h', () => {
    it('A6-4: a conta do responsável NÃO enxerga a reunião (só outra conta enxerga): antes de 3 h espera; depois vira `wrong_account` no vínculo, 1 aviso, 0 documentos', async () => {
      const a = await appt({ endedMinAgo: 60 });
      mcp.meetingsByToken.set('at-rt-de-outra-conta', [meeting(a, 'tq-4a')]); // existe, mas na conta ERRADA
      mcp.meetingsByToken.set(a.token, []);

      expect(await service.importOne(a.id, clock)).toBe('waiting'); // 1 h: ainda cedo para acusar a conta
      expect(await service.importOne(a.id, clock)).toBe('waiting');
      expect((await events(a.id)).filter((e) => e.kind === 'import_waiting')).toHaveLength(1); // 1 evento por transição, não por tentativa
      expect(await row(a.id)).toMatchObject({ import_status: 'waiting', import_attempts: 2 });
      expect(await linkStatus(a.host)).toBe('linked');

      const later = new Date(clock.getTime() + 3 * HOUR);
      expect(await service.importOne(a.id, later)).toBe('wrong_account');
      expect(await linkStatus(a.host)).toBe('wrong_account');
      expect(await row(a.id)).toMatchObject({ import_status: 'blocked' });
      expect(await sino(a.uid)).toEqual([{ payload: { reason: 'wrong_account' } }]);
      expect((await events(a.id)).filter((e) => e.kind === 'import_blocked').map((e) => e.reason)).toEqual(['wrong_account']);
      expect(await docs(a.id)).toHaveLength(0);
      expect(await vaultFiles(a.id)).toHaveLength(0);
      expect(mcp.transcriptCalls).toHaveLength(0);

      // a trava passa a valer: o vínculo não está `linked`, a importação fica bloqueada SEM novo aviso nem novo evento
      const searches = mcp.searchCalls.length;
      expect(await service.importOne(a.id, later)).toBe('blocked');
      expect(mcp.searchCalls.length).toBe(searches);
      expect(await sino(a.uid)).toHaveLength(1);
      expect((await events(a.id)).filter((e) => e.kind === 'import_blocked')).toHaveLength(1);
    });

    it('72 h sem arquivo → `expired` + alarme (log de erro com o id da reunião)', async () => {
      const a = await appt({ startedMinAgo: 73 * 60 + 30, endedMinAgo: 73 * 60 });
      mcp.meetingsByToken.set(a.token, []);
      expect(await service.importOne(a.id, clock)).toBe('expired');
      expect(await row(a.id)).toMatchObject({ import_status: 'expired' });
      expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([['import_expired', 'not_found']]);
      expect(logLines('admission.import_expired').filter((l) => l.appointmentId === a.id)).toHaveLength(1);
      expect(await docs(a.id)).toHaveLength(0);
    });

    it('depois de `waiting`, a reunião aparece no Tactiq → importa e termina `done` (a espera não é beco sem saída)', async () => {
      const a = await appt();
      mcp.meetingsByToken.set(a.token, []);
      expect(await service.importOne(a.id, clock)).toBe('waiting');
      see(a, [meeting(a, 'tq-4c')]);
      expect(await service.importOne(a.id, clock)).toBe('done');
      expect(await row(a.id)).toMatchObject({ import_status: 'done' });
    });
  });

  // ── A6-5 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A6-5: integridade', () => {
    it('soma das páginas ≠ totalChars → `rejected` (integrity), 0 objetos, 0 documentos, Vertex nem chamado', async () => {
      const a = await appt();
      const m = meeting(a, 'tq-5a');
      mcp.meetingsByToken.set(a.token, [m]);
      const ps = pages(['aaa', 'bbb', 'ccc']);
      ps.forEach((p) => { p.totalChars += 1; }); // o Tactiq "prometeu" 1 caractere a mais
      mcp.pagesByMeeting.set(m.id, ps);
      expect(await service.importOne(a.id, clock)).toBe('rejected');
      expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([['import_rejected', 'integrity']]);
      expect(await vaultFiles(a.id)).toHaveLength(0);
      expect(await docs(a.id)).toHaveLength(0);
      expect(vertex.received).toHaveLength(0);
    });

    it('lê TODAS as páginas até hasMore=false (3 páginas → 3 leituras, texto inteiro no cofre)', async () => {
      const a = await appt();
      see(a, [meeting(a, 'tq-5b')], { 'tq-5b': ['p1-a', 'p1-b', 'p2-a', 'p2-b', 'p3-a'] });
      expect(await service.importOne(a.id, clock)).toBe('done');
      expect(mcp.transcriptCalls.map((c) => c.page)).toEqual([1, 2, 3]);
      const [content] = await (await vaultFiles(a.id))[0].download();
      expect(content.toString('utf8')).toContain('p3-a');
    });
  });

  // ── A6-6 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A6-6: 2 partes SEM sobreposição (queda de conexão) → 1 objeto com as partes em ordem cronológica e os 2 ids/sha256 na trilha', async () => {
    const a = await appt();
    const p1 = meeting(a, 'tq-6-p1', { offsetMin: 0, durationSec: 600 });
    const p2 = meeting(a, 'tq-6-p2', { offsetMin: 15, durationSec: 900 });
    see(a, [p2, p1], { 'tq-6-p1': ['PARTE-UM'], 'tq-6-p2': ['PARTE-DOIS'] }); // o MCP devolve fora de ordem
    expect(await service.importOne(a.id, clock)).toBe('done');

    const files = await vaultFiles(a.id);
    expect(files).toHaveLength(1);
    const [content] = await files[0].download();
    const t = content.toString('utf8');
    expect(t.indexOf('Parte 1 de 2 · tq-6-p1')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('PARTE-UM')).toBeLessThan(t.indexOf('Parte 2 de 2 · tq-6-p2'));
    expect(t.indexOf('Parte 2 de 2 · tq-6-p2')).toBeLessThan(t.indexOf('PARTE-DOIS'));
    const matched = (await events(a.id)).find((e) => e.kind === 'import_matched');
    expect(matched?.ref).toMatchObject({ parts: 2, meetingIds: 'tq-6-p1,tq-6-p2' });
    expect(String(matched?.ref?.partSha256).split(',')).toHaveLength(2);
    expect(await docs(a.id)).toHaveLength(1);
  });

  // ── A6-7 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A6-7 (cofre): o 2º PUT do mesmo nome é recusado pela precondição (412 do emulador) e o conteúdo NÃO muda; falha do cofre deixa 0 documentos e a trilha `vault_write_failed`', async () => {
    const { GcsTranscriptVault: Vault } = await import('../../src/modules/matching/infrastructure/GcsTranscriptVault');
    const vault = new Vault({ env: process.env, client: new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' }) });
    const name = `AR/a6-7-${RUN}/transcricao-x.txt`;
    const first = await vault.putOnce(name, Buffer.from('original'), { sha256: 'x' });
    expect(first.outcome).toBe('created');
    const second = await vault.putOnce(name, Buffer.from('SOBRESCRITA'), { sha256: 'y' });
    expect(second).toEqual({ outcome: 'already_exists' });
    const [content] = await storage.bucket(VAULT_BUCKET).file(name).download();
    expect(content.toString('utf8')).toBe('original');

    // cofre sem bucket configurado: o PUT falha com motivo fechado e a importação não avança
    const semBucket = new Vault({ env: { ...process.env, ADMISSION_TRANSCRIPT_VAULT_BUCKET: '' }, client: new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' }) });
    await expect(semBucket.putOnce(name, Buffer.from('z'), { sha256: 'z' })).rejects.toMatchObject({ reason: 'not_configured' });
    const a = await appt();
    see(a, [meeting(a, 'tq-7')]);
    const { AdmissionImportService: Svc } = await import('../../src/modules/matching/application/AdmissionImportService');
    const { AdmissionImportRepository } = await import('../../src/modules/matching/infrastructure/AdmissionImportRepository');
    const { AdmissionEventRepository } = await import('../../src/modules/matching/infrastructure/AdmissionEventRepository');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const pool = DatabaseConnection.getInstance().getPool();
    const quebrado = new Svc({
      repo: new AdmissionImportRepository(pool), events: new AdmissionEventRepository(pool), tokens: link, mcp, vault: semBucket,
      summary: vertex, db: pool, log: logs.log, now: () => clock,
    });
    expect(await quebrado.importOne(a.id, clock)).toBe('vault_failed');
    expect(await row(a.id)).toMatchObject({ import_status: 'pending' });
    expect(await docs(a.id)).toHaveLength(0);
    expect(vertex.received).toHaveLength(0); // sem cofre, a transcrição NÃO segue para o Vertex
    expect((await events(a.id)).map((e) => [e.kind, e.reason])).toEqual([['import_matched', null], ['vault_write_failed', 'not_configured']]);
  });

  // ── A6-8 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A6-8 (log, §6): a saída do logger de uma importação completa NÃO contém trecho da transcrição nem do resumo, e contém sha256 e appointmentId', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-8')]);
    vertex.summary = `${RESUMO}: conteudo`;
    expect(await service.importOne(a.id, clock)).toBe('done');
    const out = logs.output();
    const sha = String((await events(a.id)).find((e) => e.kind === 'import_matched')?.ref?.sha256);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toContain(a.id);
    expect(out).toContain(sha); // o que se mede existe (zero não é sucesso)
    expect(out).toContain('admission.transcript_vaulted');
    expect(out).toContain('admission.summary_saved');
    for (const proibido of [FRASE_CLINICA, RESUMO, 'Operadora', a.host, a.token, 'meet.google.com', 'Carlota']) {
      expect(out).not.toContain(proibido);
    }
  });

  // ── H4: o Gem — trava de marcador, entrada e JSON ───────────────────────────────────────────────
  it('H4 trava: marcador sem valor no Doc -> 0 chamadas ao Vertex, `summary_failed prompt_unfilled_placeholder` na trilha e no log, SÓ com o nome', async () => {
    const viaVertex = jest.fn();
    const gen = new VertexAdmissionSummaryGenerator({ NODE_ENV: 'production', ADMISSION_SUMMARY_PROMPT_DOC_ID: 'doc-sintetico' } as NodeJS.ProcessEnv, {
      promptProvider: { getPrompt: async () => 'PROSA-DO-PROMPT-ZETA {{MARCADOR_ORFAO}}' }, vertex: viaVertex as never,
      catalogs: { segmentLabels: async () => ['SEG-SINTETICO'], pathologyTypeLabels: async () => ['PAT-SINTETICA (99)'] },
    });
    const deps = (service as unknown as { deps: { summary: unknown } }).deps;
    const original = deps.summary;
    deps.summary = gen;
    try {
      const a = await appt();
      see(a, [meeting(a, 'tq-h4-trava')]);
      expect(await service.importOne(a.id, clock)).toBe('summary_failed');
      expect(viaVertex).not.toHaveBeenCalled();
      expect(await docs(a.id)).toHaveLength(0);
      const failed = (await events(a.id)).filter((e) => e.kind === 'summary_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ reason: 'prompt_unfilled_placeholder', ref: { placeholders: 'MARCADOR_ORFAO' } });
      const out = logs.output();
      expect(out).toContain('prompt_unfilled_placeholder');
      expect(out).toContain('MARCADOR_ORFAO');
      for (const proibido of ['PROSA-DO-PROMPT-ZETA', FRASE_CLINICA]) expect(out).not.toContain(proibido);
    } finally {
      deps.summary = original;
    }
  });

  it('H4 entrada/saída: o gerador recebe entrevista_id = código ADM e fecha ISO; JSON inválido -> documento sai só com o resumo + log `admission.summary_json_invalid` sem texto', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-json')]);
    vertex.summary = `${RESUMO}: legible`;
    vertex.jsonInvalid = true;
    try {
      expect(await service.importOne(a.id, clock)).toBe('done');
    } finally {
      vertex.jsonInvalid = false;
    }
    expect(vertex.inputs.at(-1)).toEqual({ entrevistaId: expect.stringMatching(/^ADM-/), fecha: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(await docs(a.id)).toHaveLength(1);
    const out = logs.output();
    expect(out).toContain('admission.summary_json_invalid');
    for (const proibido of [FRASE_CLINICA, RESUMO]) expect(out).not.toContain(proibido);
  });

  // ── H4: truncamento, teto de tentativas e catálogo real ─────────────────────────────────────────
  it('H4 truncamento: finishReason MAX_TOKENS -> 0 documentos e `summary_failed output_truncated`, sem o texto parcial no log', async () => {
    const viaVertex = jest.fn(async () => ({ json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: `{"a":1} ${FRASE_CLINICA}` }] } }] }) }) as unknown as Response);
    const gen = new VertexAdmissionSummaryGenerator({ NODE_ENV: 'production', ADMISSION_SUMMARY_PROMPT_DOC_ID: 'doc-sintetico' } as NodeJS.ProcessEnv, {
      promptProvider: { getPrompt: async () => 'PROMPT' }, vertex: viaVertex as never,
      catalogs: { segmentLabels: async () => ['SEG-SINTETICO'], pathologyTypeLabels: async () => ['PAT-SINTETICA (99)'] },
    });
    const deps = (service as unknown as { deps: { summary: unknown } }).deps;
    const original = deps.summary;
    deps.summary = gen;
    try {
      const a = await appt();
      see(a, [meeting(a, 'tq-h4-trunc')]);
      expect(await service.importOne(a.id, clock)).toBe('summary_failed');
      expect(viaVertex).toHaveBeenCalledTimes(1);
      expect(await docs(a.id)).toHaveLength(0);
      expect((await events(a.id)).filter((e) => e.kind === 'summary_failed')).toEqual([expect.objectContaining({ reason: 'output_truncated' })]);
      expect(logs.output()).toContain('output_truncated');
      expect(logs.output()).not.toContain(FRASE_CLINICA);
    } finally {
      deps.summary = original;
    }
  });

  it('H4 teto: 3 falhas do lado do Vertex -> a 4ª execução faz 0 chamadas ao Vertex, bloqueia `summary_attempts_exhausted` UMA vez e a reunião sai da fila', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-teto')]);
    vertex.failWith = new AdmissionSummaryError('vertex_failed');
    for (let i = 0; i < 3; i += 1) expect(await service.importOne(a.id, clock)).toBe('summary_failed');
    expect(vertex.received).toHaveLength(3);
    vertex.failWith = null; // mesmo com o Vertex "curado", o teto vale
    expect(await service.importOne(a.id, clock)).toBe('blocked');
    expect(await service.importOne(a.id, clock)).toBe('blocked');
    expect(vertex.received).toHaveLength(3);
    expect(await docs(a.id)).toHaveLength(0);
    const blocked = (await events(a.id)).filter((e) => e.kind === 'import_blocked');
    expect(blocked).toEqual([expect.objectContaining({ reason: 'summary_attempts_exhausted' })]);
    expect(await row(a.id)).toMatchObject({ import_status: 'blocked' });
    expect(logs.output()).toContain('admission.import_blocked');
    const { AdmissionImportRepository } = await import('../../src/modules/matching/infrastructure/AdmissionImportRepository');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    expect(await new AdmissionImportRepository(DatabaseConnection.getInstance().getPool()).listDueIds(clock)).not.toContain(a.id);
  });

  it('H4 teto: motivos que NÃO chegam ao Vertex (prompt/catálogo) não contam — 4 falhas dessas e a 5ª execução ainda gera o documento', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-nao-conta')]);
    for (const reason of ['prompt_missing', 'prompt_unavailable', 'prompt_unfilled_placeholder', 'prompt_catalog_empty'] as const) {
      vertex.failWith = new AdmissionSummaryError(reason);
      expect(await service.importOne(a.id, clock)).toBe('summary_failed');
    }
    vertex.failWith = null;
    expect(await service.importOne(a.id, clock)).toBe('done');
    expect(await docs(a.id)).toHaveLength(1);
    expect((await events(a.id)).filter((e) => e.kind === 'import_blocked')).toHaveLength(0);
  });

  it('H4 catálogo (caminho REAL): `TherapeuticCatalogRepository.list(segments)` -> rótulos só dos ATIVOS, por sort_order, contra o Postgres', async () => {
    const { TherapeuticCatalogRepository } = await import('../../src/modules/case/infrastructure/TherapeuticCatalogRepository');
    const tag = `SEG-049-${RUN}`;
    await admin.query(
      `INSERT INTO therapeutic_segments (label, sort_order, active, deactivated_at, created_by, updated_by)
       VALUES ($1, 9001, true, NULL, 'e2e', 'e2e'), ($2, 9000, true, NULL, 'e2e', 'e2e'), ($3, 9002, false, NOW(), 'e2e', 'e2e')`,
      [`${tag}-B`, `${tag}-A`, `${tag}-INATIVO`],
    );
    try {
      const labels = (await new TherapeuticCatalogRepository().list('segments')).map((i) => i.label);
      const ours = labels.filter((l) => l.startsWith(tag));
      expect(ours).toEqual([`${tag}-A`, `${tag}-B`]);
      expect(labels.length).toBeGreaterThan(2); // as migrations semeiam os segmentos reais (495)
    } finally {
      await admin.query(`DELETE FROM therapeutic_segments WHERE label LIKE $1`, [`${tag}%`]);
    }
  });

  it('H4 teto partindo de `blocked` por OUTRO motivo: a exaustão grava o evento UMA vez, mesmo com o estado já `blocked`, e a reunião sai da fila', async () => {
    const a = await appt({ importStatus: 'blocked' });
    see(a, [meeting(a, 'tq-h4-blocked')]);
    await admin.query(`INSERT INTO admission_events (appointment_id, kind, outcome, reason) VALUES ($1,'import_blocked','blocked','no_link')`, [a.id]);
    for (let i = 0; i < 3; i += 1) {
      await admin.query(`INSERT INTO admission_events (appointment_id, kind, outcome, reason) VALUES ($1,'summary_failed','failed','empty_response')`, [a.id]);
    }
    expect(await service.importOne(a.id, clock)).toBe('blocked');
    expect(await service.importOne(a.id, clock)).toBe('blocked');
    expect(vertex.received).toHaveLength(0);
    const motivos = (await events(a.id)).filter((e) => e.kind === 'import_blocked').map((e) => e.reason).sort();
    expect(motivos).toEqual(['no_link', 'summary_attempts_exhausted']);
    const { AdmissionImportRepository } = await import('../../src/modules/matching/infrastructure/AdmissionImportRepository');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    expect(await new AdmissionImportRepository(DatabaseConnection.getInstance().getPool()).listDueIds(clock)).not.toContain(a.id);
  });

  it('H4 teto: 5 falhas TRANSITÓRIAS do Vertex (429/5xx/rede) seguidas não bloqueiam, e a 6ª execução gera o documento', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-transit')]);
    vertex.failWith = new AdmissionSummaryError('vertex_transient');
    for (let i = 0; i < 5; i += 1) expect(await service.importOne(a.id, clock)).toBe('summary_failed');
    vertex.failWith = null;
    expect(await service.importOne(a.id, clock)).toBe('done');
    expect(await docs(a.id)).toHaveLength(1);
    expect((await events(a.id)).filter((e) => e.kind === 'import_blocked')).toHaveLength(0);
  });

  it('H4 teto pós-modelo: o PDF lança 3 vezes -> `post_model_failed` conta; a 4ª execução faz 0 chamadas ao Vertex e há 1 evento de exaustão; sem objeto órfão', async () => {
    const pdfModule = await import('../../src/modules/matching/infrastructure/admissionSummaryPdf');
    const spy = jest.spyOn(pdfModule, 'renderAdmissionSummaryPdf').mockRejectedValue(new Error('pdf quebrou'));
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-pos')]);
    const pdfsBefore = (await docFiles()).length;
    try {
      for (let i = 0; i < 3; i += 1) expect(await service.importOne(a.id, clock)).toBe('summary_failed');
      expect(vertex.received).toHaveLength(3);
      expect((await events(a.id)).filter((e) => e.kind === 'summary_failed').map((e) => e.reason)).toEqual(['post_model_failed', 'post_model_failed', 'post_model_failed']);
      expect(await service.importOne(a.id, clock)).toBe('blocked');
      expect(vertex.received).toHaveLength(3);
      expect((await events(a.id)).filter((e) => e.kind === 'import_blocked')).toEqual([expect.objectContaining({ reason: 'summary_attempts_exhausted' })]);
      expect(await docs(a.id)).toHaveLength(0);
      expect((await docFiles()).length).toBe(pdfsBefore);
    } finally {
      spy.mockRestore();
    }
  });

  it('H4 pós-modelo: a transação falha DEPOIS do upload do PDF -> `discard` do objeto é chamado e o evento `post_model_failed` nasce', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-commit')]);
    const discard = jest.fn(async () => undefined);
    const svc = service as unknown as { documents: unknown };
    const original = svc.documents;
    svc.documents = { prepare: async () => ({ commit: async () => { throw new Error('tx quebrou'); }, discard }) };
    try {
      expect(await service.importOne(a.id, clock)).toBe('summary_failed');
      expect(discard).toHaveBeenCalledTimes(1);
      expect((await events(a.id)).filter((e) => e.kind === 'summary_failed')).toEqual([expect.objectContaining({ reason: 'post_model_failed' })]);
      expect(await docs(a.id)).toHaveLength(0);
    } finally {
      svc.documents = original;
    }
  });

  it('H4 teto: 3 `vertex_timeout` contam -> a 4ª execução faz 0 chamadas; `vertex_auth_failed` NÃO conta e tem log próprio', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-h4-timeout')]);
    vertex.failWith = new AdmissionSummaryError('vertex_timeout');
    for (let i = 0; i < 3; i += 1) expect(await service.importOne(a.id, clock)).toBe('summary_failed');
    expect(await service.importOne(a.id, clock)).toBe('blocked');
    expect(vertex.received).toHaveLength(3);
    expect((await events(a.id)).filter((e) => e.kind === 'import_blocked')).toEqual([expect.objectContaining({ reason: 'summary_attempts_exhausted' })]);

    const b = await appt();
    see(b, [meeting(b, 'tq-h4-auth')]);
    vertex.failWith = new AdmissionSummaryError('vertex_auth_failed');
    for (let i = 0; i < 4; i += 1) expect(await service.importOne(b.id, clock)).toBe('summary_failed');
    vertex.failWith = null;
    expect(await service.importOne(b.id, clock)).toBe('done');
    expect(logs.output()).toContain('admission.vertex_auth_failed');
  });

  // ── A6-9 ─────────────────────────────────────────────────────────────────────────────────────────
  it('A6-9: vínculo `broken` ou ausente → `blocked` (no_link) + alarme, 0 chamadas ao MCP; 401 no meio vira `broken` e bloqueia', async () => {
    const quebrado = await appt({ link: 'broken', importStatus: 'pending' });
    const semVinculo = await appt({ link: 'none', importStatus: 'pending' });
    for (const x of [quebrado, semVinculo]) {
      see(x, [meeting(x, `tq-9-${x.code}`)]);
      expect(await service.importOne(x.id, clock)).toBe('blocked');
      expect(await row(x.id)).toMatchObject({ import_status: 'blocked' });
      expect((await events(x.id)).map((e) => [e.kind, e.reason])).toEqual([['import_blocked', 'no_link']]);
      expect(await docs(x.id)).toHaveLength(0);
    }
    expect(mcp.searchCalls).toHaveLength(0);
    expect(mcp.transcriptCalls).toHaveLength(0);
    expect(logLines('admission.import_blocked').filter((l) => l.appointmentId === quebrado.id && l.reason === 'no_link')).toHaveLength(1);

    // a 2ª passada continua bloqueada, sem evento novo (1 evento por transição) mas com o alarme no log
    expect(await service.importOne(quebrado.id, clock)).toBe('blocked');
    expect((await events(quebrado.id)).filter((e) => e.kind === 'import_blocked')).toHaveLength(1);
    expect(logLines('admission.import_blocked').filter((l) => l.appointmentId === quebrado.id)).toHaveLength(2);

    const vivo = await appt();
    mcp.searchError = new TactiqUnauthorizedError();
    expect(await service.importOne(vivo.id, clock)).toBe('blocked');
    expect(await linkStatus(vivo.host)).toBe('broken');
    expect(await sino(vivo.uid)).toEqual([{ payload: { reason: 'broken' } }]);
  });

  it('falha transitória do MCP (rede/5xx) NÃO muda estado nem vínculo: `transient`, tenta na próxima rodada', async () => {
    const a = await appt();
    const { TactiqTransientError } = await import('../../src/modules/matching/application/ports/TactiqPorts');
    mcp.searchError = new TactiqTransientError('timeout');
    expect(await service.importOne(a.id, clock)).toBe('transient');
    expect(await row(a.id)).toMatchObject({ import_status: 'pending' });
    expect(await linkStatus(a.host)).toBe('linked');
    expect(await events(a.id)).toEqual([]);
  });

  // ── rota interna ─────────────────────────────────────────────────────────────────────────────────
  it('rota POST /api/internal/jobs/admission-import: sem segredo 403; com segredo 200, importa a devida e devolve SÓ contagens numéricas', async () => {
    const a = await appt();
    see(a, [meeting(a, 'tq-rota')]);
    const negado = await fetch(`${app.url}/api/internal/jobs/admission-import`, { method: 'POST' });
    expect(negado.status).toBe(403);
    const ok = await fetch(`${app.url}/api/internal/jobs/admission-import`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([
      'alreadyDone', 'ambiguous', 'blocked', 'candidates', 'done', 'errors', 'expired', 'failed', 'rejected', 'skipped', 'transient', 'waiting', 'wrongAccount',
    ]);
    expect(Object.values(body.data).every((v) => typeof v === 'number')).toBe(true);
    expect(body.data.done as number).toBeGreaterThanOrEqual(1);
    expect(await row(a.id)).toMatchObject({ import_status: 'done' });
  });
});
