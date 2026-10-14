/**
 * enquadre-052-import.e2e.test.ts — spec 052, Fase 3 (T-34b rodada 2, T-37a): a IMPORTAÇÃO do Tactiq do enquadre contra POSTGRES REAL
 * (`enquadre_events`, migrações 518 e 521). É a MESMA `AdmissionImportService` da admissão, instanciada com a fonte
 * (`EnquadreImportRepository`), o destino (`EnquadreImportDestination`) e a trilha (`EnquadreEventTrailRepository`) do enquadre, SEM
 * paciente no caminho. Só as fronteiras de terceiros são dublê, e vêm da MESMA fábrica da admissão (`createAdmissionExternals`,
 * modo `fake`): Tactiq (OAuth e MCP), cofre do enquadre (memória, mesma semântica de só-criação) e gerador de resumo. O PDF sobe por um
 * armazenamento em memória na costura de `StoreAdmissionSummaryDocument` (sem fake-gcs: nada toca bucket real). Sem a API no ar: o serviço
 * é chamado direto e a rota interna roda no app de teste. Dados SINTÉTICOS; a transcrição leva um marcador que NUNCA pode aparecer em log.
 *
 * A achou → `done` (cofre + documento do EVENTO, nada nos documentos do paciente) · B não achou → `waiting`/`code_mismatch` ·
 * C conta errada → `blocked`/`wrong_account` (o serviço da admissão, intacto, bloqueia; `rejected` é o código certo fora da janela) ·
 * D sem vínculo do Tactiq → `blocked`/`no_link` e volta quando o vínculo existe · E gate de forma do enquadre · F lote próprio e fila ·
 * G rota interna · H log e trilha sem o texto, sem nome, sem e-mail (com controle positivo).
 */
import { inflateSync } from 'zlib';
import { Pool } from 'pg';
import { montarAppDeFamilia, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { criarEscopoDeEnv } from './helpers/admissionHarnessKit';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeMeetConference } from '../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import type { FakeAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import type { InMemoryTranscriptVault } from '../../src/modules/matching/infrastructure/doubles/InMemoryTranscriptVault';
import { validEnquadreSummaryJson } from '../../src/modules/matching/infrastructure/doubles/enquadreSummaryFixtures';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { AdmissionSummaryError } from '../../src/modules/matching/application/ports/AdmissionImportPorts';
import type { TactiqMeetingItem, TactiqTranscriptPage } from '../../src/modules/matching/application/ports/TactiqPorts';
import type { AdmissionImportService } from '../../src/modules/matching/application/AdmissionImportService';
import type { EnquadreImportSubject } from '../../src/modules/matching/infrastructure/EnquadreImportRepository';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SECRET = 'test-secret-for-e2e-only';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
const MIN = 60_000;
const HOUR = 60 * MIN;
const POSTING_TITLE = `ENQ052 import ${RUN}`;

/** SINTÉTICOS que NUNCA podem aparecer em log nem na trilha (os dois primeiros só existem na transcrição e nos nomes dos convocados). */
const TRANSCRICAO = 'TRANSCRICAO-SINTETICA-052';
const RESUMO = 'RESUMO-SINTETICO-OMEGA';
const NOME_1 = 'Prestadora Sintetica Alfa';
const NOME_2 = 'Prestador Sintetico Beta';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

/** Texto de todas as streams do PDF, já descomprimidas, + a forma hex que o pdf-lib usa em `drawText`. */
function pdfText(buf: Buffer): string {
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

describe('importação do Tactiq do enquadre — mesma lógica da admissão, fonte, destino e trilha do enquadre (spec 052, F3)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let mcp: FakeTactiqMcp;
  let oauth: FakeTactiqOAuth;
  let vertex: FakeAdmissionSummaryGenerator;
  let vault: InMemoryTranscriptVault;
  let admissionVault: InMemoryTranscriptVault;
  let service: AdmissionImportService<EnquadreImportSubject>;
  let logs: ReturnType<typeof capturingLogger>;
  const pdfs = new Map<string, Buffer>(); // o "bucket" de documentos: caminho -> PDF
  let clock = new Date();
  let seq = 0;
  let postingId = '';
  let patientId = '';
  const hostEmails: string[] = [];
  const hostUids: string[] = [];
  const workerIds: string[] = [];
  const env = criarEscopoDeEnv();

  const code = (): string => `ENC-${(RUN + String(seq).padStart(3, '0')).slice(-6)}`;
  interface Ev { id: string; code: string; host: string; token: string; start: Date; uid: string }

  /** Evento com o fim real JÁ gravado (o job de fim de call fez isso). `link`: vínculo do Tactiq do responsável (padrão: vivo). */
  async function evento(o: { startedMinAgo?: number; endedMinAgo?: number; importStatus?: string | null; status?: string; link?: 'linked' | 'none'; withEnd?: boolean; convocados?: string[] } = {}): Promise<Ev & { parts: string[] }> {
    seq += 1;
    const start = new Date(clock.getTime() - (o.startedMinAgo ?? 120) * MIN);
    const end = new Date(start.getTime() + 30 * MIN);
    const endedAt = o.withEnd === false ? null : new Date(clock.getTime() - (o.endedMinAgo ?? 80) * MIN);
    const host = `host${seq}.${RUN}@example.test`.toLowerCase();
    const uid = `imp052-${seq}-${RUN}`;
    const c = code();
    const status = o.status ?? 'open';
    const { rows } = await admin.query(
      `INSERT INTO enquadre_events
         (job_posting_id, country, host_email, host_display_name, starts_at, ends_at, event_code, status, meet_link,
          created_by_uid, import_status, conference_ended_at, closed_at, closed_by_uid, cancelled_at, cancelled_by_uid)
       VALUES ($1,'AR',$2,'Entrevistadora Sintetica',$3,$4,$5,$6,'https://meet.google.com/abc-defg-hij','enq052-uid',$7,$8,
               CASE WHEN $6 = 'closed' THEN now() END, CASE WHEN $6 = 'closed' THEN 'enq052-uid' END,
               CASE WHEN $6 = 'cancelled' THEN now() END, CASE WHEN $6 = 'cancelled' THEN 'enq052-uid' END) RETURNING id`,
      [postingId, host, start, end, c, status, o.importStatus === undefined ? 'pending' : o.importStatus, endedAt],
    );
    hostEmails.push(host);
    const token = `rt-imp052-${seq}-${RUN}`;
    await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [uid, host, TENANT_E2E]);
    hostUids.push(uid);
    if ((o.link ?? 'linked') === 'linked') await vincular(host, uid, token);
    const parts: string[] = [];
    for (const nome of o.convocados ?? []) parts.push(await convocar(rows[0].id, nome));
    return { id: rows[0].id as string, code: c, host, token: `at-${token}`, start, uid, parts };
  }

  async function vincular(host: string, uid: string, token: string): Promise<void> {
    const ins = await admin.query(
      `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, last_notified_status) VALUES ($1,$2,'linked',$3,'linked') RETURNING id`,
      [host, uid, clock],
    );
    await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1,$2)`, [ins.rows[0].id, b64(token)]);
  }

  async function convocar(eventId: string, nome: string): Promise<string> {
    const [first, ...rest] = nome.split(' ');
    const wk = await admin.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1,$2,'AR','America/Argentina/Buenos_Aires','REGISTERED',$3,$4) RETURNING id`,
      [`enq052-imp-w-${RUN}-${workerIds.length}`, `w${workerIds.length}.${RUN}@example.test`.toLowerCase(), b64(first), b64(rest.join(' '))], // KMS em passthrough: base64
    );
    workerIds.push(wk.rows[0].id);
    const p = await admin.query(
      `INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid) VALUES ($1,$2,$3,'u') RETURNING id`,
      [eventId, postingId, wk.rows[0].id],
    );
    return p.rows[0].id as string;
  }

  const meeting = (a: Ev, id: string, o: { title?: string; offsetMin?: number; durationSec?: number } = {}): TactiqMeetingItem => ({
    id, title: o.title ?? `${a.code} Encuadre`, createdAt: new Date(a.start.getTime() + (o.offsetMin ?? 0) * MIN).toISOString(), durationSeconds: o.durationSec ?? 1800,
  });
  function pages(texts: string[]): TactiqTranscriptPage[] {
    const total = texts.reduce((n, t) => n + t.length, 0);
    return [{ page: 1, totalPages: 1, totalChars: total, hasMore: false, entries: texts.map((t, j) => ({ text: t, speaker: 'Hablante', startSeconds: j * 10, endSeconds: j * 10 + 9 })) }];
  }
  function ver(a: Ev, items: TactiqMeetingItem[]): void {
    mcp.meetingsByToken.set(a.token, items);
    for (const m of items) mcp.pagesByMeeting.set(m.id, pages([`${TRANSCRICAO} um`, 'dois', 'tres']));
  }

  const row = async (id: string) =>
    (await admin.query(`SELECT status, import_status, import_attempts, blocked_reason, transcript_object_path, transcript_sha256 FROM enquadre_events WHERE id = $1`, [id])).rows[0];
  const trilha = async (id: string) =>
    (await admin.query(`SELECT kind, outcome, reason, ref FROM enquadre_event_trail WHERE event_id = $1 ORDER BY at, kind`, [id])).rows as Array<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, any> | null }>;
  const kinds = async (id: string) => (await trilha(id)).map((e) => e.kind);
  const docs = async (id: string) => (await admin.query(`SELECT * FROM enquadre_event_documents WHERE event_id = $1`, [id])).rows as Array<Record<string, any>>;
  const linkStatus = async (email: string) => (await admin.query(`SELECT status FROM tactiq_links WHERE lower(host_email) = lower($1)`, [email])).rows[0]?.status as string;

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM enquadre_event_documents WHERE event_id IN (SELECT id FROM enquadre_events WHERE job_posting_id = $1)`, [postingId]);
    await admin.query(`DELETE FROM enquadre_events WHERE job_posting_id = $1`, [postingId]);
    await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [hostEmails]).catch(() => undefined);
    hostEmails.length = 0;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    env.setAll({ USE_MOCK_AUTH: 'true', DATABASE_URL, INTERNAL_TOKEN_SECRET: SECRET });
    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1,'Ficticia',$2,'AR',true) RETURNING id`,
      [`e2e-052-imp-${RUN}`, `Sobrenomeunico${RUN}`],
    );
    patientId = pat.rows[0].id;
    const post = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number) VALUES ($1,$2,'SEARCHING',false,'AR',true,$3) RETURNING id`,
      [POSTING_TITLE, patientId, 810000 + Math.floor(Math.random() * 90000)],
    );
    postingId = post.rows[0].id;

    // as fronteiras vêm da MESMA fábrica da admissão, em modo `fake`
    const { createAdmissionExternals } = await import('../../src/modules/matching/infrastructure/admissionExternals');
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp: () => { throw new Error('canal real'); } });
    oauth = new FakeTactiqOAuth();
    mcp = new FakeTactiqMcp();
    vertex = ext.enquadreSummary as FakeAdmissionSummaryGenerator;
    vault = ext.enquadreVault as InMemoryTranscriptVault;
    admissionVault = ext.vault as InMemoryTranscriptVault;
    logs = capturingLogger();

    app = await montarAppDeFamilia({
      montarRotas: async ({ app: express }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        const { StoreAdmissionSummaryDocument } = await import('../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument');
        const { registerEnquadreInternalJobRoutes, createEnquadreImportService } = await import('../../src/bootstrap/registerEnquadreInternalJobRoutes');
        const pool = DatabaseConnection.getInstance().getPool();
        const link = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log, now: () => clock });
        // armazenamento do PDF em memória, na costura de `StoreAdmissionSummaryDocument`: o objeto fica em `pdfs`, nada toca bucket
        const storage = {
          uploadBuffer: async (buf: Buffer, _ct: string, prefix?: string) => {
            const objectPath = `${prefix}/${pdfs.size + 1}-${RUN}.pdf`;
            pdfs.set(objectPath, buf);
            return { objectPath };
          },
          delete: async (p: string) => { pdfs.delete(p); },
        };
        const store = new StoreAdmissionSummaryDocument(undefined, undefined, () => storage as never);
        const imp = { tokens: link, mcp, vault, summary: vertex, destination: { store }, log: logs.log, now: () => clock };
        service = createEnquadreImportService(pool, imp);
        // a rota REAL (wiring de produção) com as mesmas fronteiras e o relógio de verdade
        registerEnquadreInternalJobRoutes(express, { db: pool, meet: new FakeMeetConference(), import: { ...imp, now: () => new Date() } });
      },
    });
  }, 90000);

  beforeEach(async () => {
    clock = new Date();
    mcp.reset();
    vertex.reset();
    vault.objects.clear();
    vault.putCalls.length = 0;
    admissionVault.putCalls.length = 0;
    pdfs.clear();
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await admin.query(`DELETE FROM job_postings WHERE id = $1`, [postingId]).catch(() => undefined);
    await admin.query(`DELETE FROM workers WHERE id = ANY($1)`, [workerIds]).catch(() => undefined);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => undefined);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [hostUids]).catch(() => undefined);
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.end();
  });

  // ── A ────────────────────────────────────────────────────────────────────────────────────────────
  it('A: achou (código exato, janela, 1 candidata, soma bate) → `done`, 1 objeto no cofre DO ENQUADRE, 1 documento do EVENTO e NADA nos documentos do paciente', async () => {
    const e = await evento({ convocados: [NOME_1, NOME_2] });
    ver(e, [meeting(e, 'tq-a')]);
    vertex.summary = `${RESUMO}: ponto A.`;
    vertex.structured = validEnquadreSummaryJson(e.code, [e.parts[0], e.parts[1]]);

    expect(await service.importOne(e.id, clock)).toBe('done');

    expect(mcp.searchCalls).toEqual([{
      token: e.token, query: e.code,
      dateFrom: new Date(e.start.getTime() - 15 * MIN).toISOString(), dateTo: new Date(e.start.getTime() + 60 * MIN).toISOString(),
    }]);
    const r = await row(e.id);
    expect(r).toMatchObject({ import_status: 'done', status: 'open', blocked_reason: null });

    // cofre: a chave é `<país>/enquadre/<event_id>/transcricao-<sha>.txt`, no cofre do ENQUADRE (a admissão não foi tocada)
    expect([...vault.objects.keys()]).toEqual([`AR/enquadre/${e.id}/transcricao-${r.transcript_sha256}.txt`]);
    expect(r.transcript_object_path).toBe(`AR/enquadre/${e.id}/transcricao-${r.transcript_sha256}.txt`);
    expect(r.transcript_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(admissionVault.putCalls).toHaveLength(0);
    expect([...vault.objects.values()][0].body.toString('utf8')).toContain(TRANSCRICAO); // a transcrição crua está NO COFRE

    // documento: linha do EVENTO, cifrada, com a versão do prompt; o PDF mora sob o prefixo do enquadre
    const d = await docs(e.id);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ content_type: 'application/pdf', prompt_version: 'fake-v0', created_by_uid: 'system:enquadre-import' });
    const dd = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' }).format(e.start);
    expect(unb64(d[0].label_encrypted)).toBe(`Resumen de encuadre · ${dd}`);
    const path = unb64(d[0].file_path_encrypted);
    expect(path.startsWith('enquadre-documents/')).toBe(true);
    const pdf = pdfs.get(path) as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfText(pdf)).toContain(hexOf(RESUMO));
    expect(pdfText(pdf)).not.toContain(hexOf(TRANSCRICAO)); // a transcrição crua não está no PDF
    // NADA nos documentos do paciente: nem por este caminho cifrado, nem do ator do enquadre
    expect((await admin.query(`SELECT count(*)::int AS n FROM patient_documents WHERE file_path_encrypted = $1 OR created_by_uid = 'system:enquadre-import'`, [d[0].file_path_encrypted])).rows[0].n).toBe(0);

    // o Vertex recebeu a transcrição e a lista de convocados (ref = id da participação + nome, e mais nada)
    expect(vertex.received).toHaveLength(1);
    expect(vertex.received[0]).toContain(TRANSCRICAO);
    expect(vertex.inputs[0]).toMatchObject({ entrevistaId: e.code, convocados: [{ ref: e.parts[0], nombre: NOME_1 }, { ref: e.parts[1], nombre: NOME_2 }] });
    expect(Object.keys((vertex.inputs[0].convocados as Array<object>)[0]).sort()).toEqual(['nombre', 'ref']);

    // trilha própria, só ids/hash
    expect(await kinds(e.id)).toEqual(['import_matched', 'transcript_vaulted', 'summary_saved']);
    expect((await trilha(e.id)).find((t) => t.kind === 'summary_saved')?.ref).toMatchObject({ documentId: d[0].id, promptVersion: 'fake-v0' });

    // 2ª passada: `already_done`, sem tocar o Tactiq nem o Vertex; 1 documento, 1 objeto
    const buscas = mcp.searchCalls.length;
    expect(await service.importOne(e.id, clock)).toBe('already_done');
    expect(mcp.searchCalls.length).toBe(buscas);
    expect(vertex.received).toHaveLength(1);
    expect(await docs(e.id)).toHaveLength(1);
    expect(vault.objects.size).toBe(1);
  });

  // ── B ────────────────────────────────────────────────────────────────────────────────────────────
  it('B: não achou → `waiting` com motivo (not_found / code_mismatch), 1 evento por transição, e quando o arquivo aparece importa', async () => {
    const e = await evento();
    mcp.meetingsByToken.set(e.token, []);
    expect(await service.importOne(e.id, clock)).toBe('waiting');
    ver(e, [meeting(e, 'tq-b', { title: `${e.code}Z Outra reunião` }), meeting(e, 'tq-b2', { title: `X${e.code} Outra` })]);
    expect(await service.importOne(e.id, clock)).toBe('waiting');
    expect((await trilha(e.id)).map((t) => [t.kind, t.reason])).toEqual([['import_waiting', 'not_found']]); // 2ª espera = mesmo estado, sem novo evento
    expect(await row(e.id)).toMatchObject({ import_status: 'waiting', import_attempts: 2, blocked_reason: null });
    // código PARECIDO nunca casa: nada no cofre, nada no Vertex, nenhum documento
    expect(vault.objects.size).toBe(0);
    expect(vertex.received).toHaveLength(0);
    expect(await docs(e.id)).toHaveLength(0);

    const f = await evento();
    ver(f, [meeting(f, 'tq-b3', { title: `${f.code}Z Outra reunião` })]);
    expect(await service.importOne(f.id, clock)).toBe('waiting');
    expect((await trilha(f.id)).map((t) => [t.kind, t.reason])).toEqual([['import_waiting', 'code_mismatch']]);

    ver(e, [meeting(e, 'tq-b4')]);
    expect(await service.importOne(e.id, clock)).toBe('done');
    expect(await row(e.id)).toMatchObject({ import_status: 'done' });
  });

  // ── C ────────────────────────────────────────────────────────────────────────────────────────────
  it('C: a conta do responsável NÃO enxerga a reunião (só outra conta): espera; depois de 3 h o serviço da admissão, intacto, bloqueia com `wrong_account`; fora da janela é `rejected`', async () => {
    const e = await evento({ endedMinAgo: 60 });
    mcp.meetingsByToken.set('at-rt-de-outra-conta', [meeting(e, 'tq-c')]); // existe, mas na conta ERRADA
    mcp.meetingsByToken.set(e.token, []);
    expect(await service.importOne(e.id, clock)).toBe('waiting');
    const later = new Date(clock.getTime() + 3 * HOUR);
    expect(await service.importOne(e.id, later)).toBe('wrong_account');
    expect(await linkStatus(e.host)).toBe('wrong_account');
    expect(await row(e.id)).toMatchObject({ import_status: 'blocked', blocked_reason: 'wrong_account' });
    expect((await trilha(e.id)).filter((t) => t.kind === 'import_blocked').map((t) => t.reason)).toEqual(['wrong_account']);
    expect(vault.objects.size).toBe(0);
    expect(await docs(e.id)).toHaveLength(0);
    expect(mcp.transcriptCalls).toHaveLength(0);

    // o código certo mas FORA da janela de tempo é `rejected`
    const f = await evento();
    ver(f, [meeting(f, 'tq-c2', { offsetMin: 180 })]);
    expect(await service.importOne(f.id, clock)).toBe('rejected');
    expect(await row(f.id)).toMatchObject({ import_status: 'rejected', blocked_reason: null });
    expect((await trilha(f.id)).map((t) => [t.kind, t.reason])).toEqual([['import_rejected', 'time_window']]);
    expect(vault.objects.size).toBe(0);
  });

  // ── D ────────────────────────────────────────────────────────────────────────────────────────────
  it('D: responsável SEM vínculo do Tactiq → `blocked` com motivo `no_link` (nada pago é chamado); refeito o vínculo, importa e o motivo some', async () => {
    const e = await evento({ link: 'none' });
    ver(e, [meeting(e, 'tq-d')]);
    expect(await service.importOne(e.id, clock)).toBe('blocked');
    expect(await row(e.id)).toMatchObject({ import_status: 'blocked', blocked_reason: 'no_link' });
    expect((await trilha(e.id)).map((t) => [t.kind, t.reason])).toEqual([['import_blocked', 'no_link']]);
    expect(mcp.searchCalls).toHaveLength(0);
    expect(vault.objects.size).toBe(0);
    expect(vertex.received).toHaveLength(0);

    await vincular(e.host, e.uid, e.token.replace(/^at-/, ''));
    expect(await service.importOne(e.id, clock)).toBe('done');
    expect(await row(e.id)).toMatchObject({ import_status: 'done', blocked_reason: null }); // sai do blocked → o motivo some (CHECK da 521)
  });

  // ── E ────────────────────────────────────────────────────────────────────────────────────────────
  it('E: o gate de forma é o do ENQUADRE — convocado_ref inventada ou bloco faltando → `summary_failed`/schema_invalid; 3 falhas → `blocked`/summary_attempts_exhausted e sai da fila', async () => {
    const e = await evento({ convocados: [NOME_1] });
    ver(e, [meeting(e, 'tq-e')]);
    vertex.structured = validEnquadreSummaryJson(e.code, ['REF-INVENTADA']);
    expect(await service.importOne(e.id, clock)).toBe('summary_failed');
    expect((await trilha(e.id)).filter((t) => t.kind === 'summary_failed').map((t) => [t.reason])).toEqual([['schema_invalid']]);
    expect(await docs(e.id)).toHaveLength(0);
    expect(await row(e.id)).toMatchObject({ import_status: 'pending' }); // o estado não anda: tenta de novo na rodada seguinte

    vertex.structured = (() => { const j = validEnquadreSummaryJson(e.code, [e.parts[0]]); delete j.sin_atribuir; return j; })();
    expect(await service.importOne(e.id, clock)).toBe('summary_failed');
    vertex.failWith = new AdmissionSummaryError('empty_response');
    expect(await service.importOne(e.id, clock)).toBe('summary_failed');
    vertex.failWith = null;
    expect(await service.importOne(e.id, clock)).toBe('blocked'); // 3 tentativas pagas falharam: a 4ª nem chama o modelo
    expect(await row(e.id)).toMatchObject({ import_status: 'blocked', blocked_reason: 'summary_attempts_exhausted' });
    const { EnquadreImportRepository } = await import('../../src/modules/matching/infrastructure/EnquadreImportRepository');
    expect(await new EnquadreImportRepository(admin).listDueIds(clock)).not.toContain(e.id);
    expect(vault.objects.size).toBe(1); // a transcrição ficou no cofre da 1ª vez (só-criação); as outras passadas viram already_vaulted
  });

  // ── F ────────────────────────────────────────────────────────────────────────────────────────────
  it('F: a fila — lote PRÓPRIO configurável; entra open|closed com fim real há > 10 min em pending|waiting|blocked; cancelado, sem fim, cedo demais, done e no_show não', async () => {
    const { EnquadreImportRepository } = await import('../../src/modules/matching/infrastructure/EnquadreImportRepository');
    const pendente = await evento({ endedMinAgo: 90 });
    const fechado = await evento({ endedMinAgo: 80, status: 'closed' });
    const bloqueado = await evento({ endedMinAgo: 70, importStatus: 'blocked' });
    const esperando = await evento({ endedMinAgo: 60, importStatus: 'waiting' });
    const fora = [
      await evento({ endedMinAgo: 90, status: 'cancelled' }), await evento({ withEnd: false, importStatus: null }), await evento({ endedMinAgo: 5 }),
      await evento({ endedMinAgo: 90, importStatus: 'done' }), await evento({ endedMinAgo: 90, importStatus: 'no_show' }),
    ];
    const todos = await new EnquadreImportRepository(admin).listDueIds(clock, 100);
    for (const e of [pendente, fechado, bloqueado, esperando]) expect(todos).toContain(e.id);
    for (const e of fora) expect(todos).not.toContain(e.id);
    // lote próprio: 2 por rodada, do mais antigo ao mais novo; o resto fica para a rodada seguinte
    expect(await new EnquadreImportRepository(admin, 2).listDueIds(clock)).toEqual([pendente.id, fechado.id]);
    // `find`: open/closed são `booked` (o serviço só aceita `booked`); código ENC- e horário vêm do evento; sem paciente
    const f = await new EnquadreImportRepository(admin).find(fechado.id);
    expect(f).toMatchObject({ status: 'booked', admission_code: fechado.code, patient_is_test: false, rehearsal_until: null, country: 'AR' });
    expect((await new EnquadreImportRepository(admin).find(fora[0].id))?.status).toBe('cancelled');
    // um evento cancelado nem é elegível para o serviço
    expect(await service.importOne(fora[0].id, clock)).toBe('not_eligible');
  });

  // ── G ────────────────────────────────────────────────────────────────────────────────────────────
  it('G: a rota interna POST /api/internal/jobs/enquadre-import exige X-Internal-Secret e, com ele, roda a importação e devolve só contagens', async () => {
    const e = await evento({ endedMinAgo: 120 });
    ver(e, [meeting(e, 'tq-g')]);
    const negado = await fetch(`${app.url}/api/internal/jobs/enquadre-import`, { method: 'POST' });
    expect([401, 403]).toContain(negado.status);
    expect((await row(e.id)).import_status).toBe('pending');
    const ok = await fetch(`${app.url}/api/internal/jobs/enquadre-import`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; data: Record<string, number> };
    expect(body.success).toBe(true);
    expect(body.data.done).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.data).sort()).toEqual(expect.arrayContaining(['candidates', 'done', 'waiting', 'blocked']));
    expect(await row(e.id)).toMatchObject({ import_status: 'done' });
    expect(await docs(e.id)).toHaveLength(1);
  });

  // ── H ────────────────────────────────────────────────────────────────────────────────────────────
  it('H: log e trilha só com ids, hashes e contagens — nem o texto da transcrição, nem o resumo, nem os nomes dos convocados, nem o e-mail (controle positivo: o log TEM o id do evento)', async () => {
    const e = await evento({ convocados: [NOME_1] });
    ver(e, [meeting(e, 'tq-h')]);
    vertex.summary = `${RESUMO}: ponto A.`;
    vertex.structured = validEnquadreSummaryJson(e.code, [e.parts[0]]);
    expect(await service.importOne(e.id, clock)).toBe('done');
    const f = await evento({ link: 'none' });
    expect(await service.importOne(f.id, clock)).toBe('blocked');
    const g = await evento();
    ver(g, [meeting(g, 'tq-h2')]);
    vertex.failWith = new AdmissionSummaryError('vertex_failed');
    expect(await service.importOne(g.id, clock)).toBe('summary_failed');

    const visivel = `${JSON.stringify(await trilha(e.id))}${JSON.stringify(await trilha(f.id))}${JSON.stringify(await trilha(g.id))}\n${logs.output()}`;
    expect(visivel).toContain(e.id); // controle positivo
    expect(logs.output()).toContain('"message":"enquadre.import_matched"'); // e a medição enxerga o log do enquadre, não o da admissão
    expect(vertex.received.join('')).toContain(TRANSCRICAO); // controle positivo: o marcador EXISTIU e chegou ao Vertex
    for (const proibido of [TRANSCRICAO, RESUMO, NOME_1, 'example.test', 'meet.google.com']) expect(visivel).not.toContain(proibido);
    expect(visivel).not.toContain('"message":"admission.');
  });
});
