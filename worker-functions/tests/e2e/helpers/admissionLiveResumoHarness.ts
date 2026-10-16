/**
 * admissionLiveResumoHarness — spec 050, 4º passo, F28 (R-49, R-51 a R-56): o resumo "assim que a transcrição estiver pronta".
 * Banco REAL, as TRÊS rotas internas de verdade (`admission-post-call`, `admission-live`, `admission-import`, com os middlewares reais),
 * vínculo do Tactiq REAL (`TactiqLinkService`) e a importação REAL; Meet, Tactiq (MCP e OAuth), cofre, bucket de ensaio e Vertex são
 * dublês que CONTAM. O RELÓGIO é parâmetro (minutos depois das 10:00 de um dia fixo): nada espera tempo de verdade. Dados sintéticos
 * (@example.test). Nada toca canal real.
 *
 * Quem muda entre os arquivos `-runtime` e `-dono` é só quem conecta (`runtime`: login membro de `app_runtime` + pool de sistema
 * `app_system`, RLS de país ligada, como a stage; `dono`: controle, bypassa RLS, como a produção).
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { LiveFixtures, type ReuniaoViva } from './admissionLiveFixtures';
import { FakeMeetConference } from '../../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeAdmissionSummaryGenerator } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import { InMemoryTranscriptVault } from '../../../src/modules/matching/infrastructure/doubles/InMemoryTranscriptVault';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { TactiqMeetingItem } from '../../../src/modules/matching/application/ports/TactiqPorts';
import type { AdmissionImportService } from '../../../src/modules/matching/application/AdmissionImportService';
import type { StoreAdmissionSummaryDocument } from '../../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
export type ConexaoResumo = 'runtime' | 'dono';
export const MIN = 60_000;
export const T0 = new Date('2031-04-14T10:00:00Z');
export const SEGREDO = 'test-secret-for-e2e-only';
const SENHA = 'adm050_rsm_pw';

export interface ReuniaoResumo { id: string; code: string; meetCode: string; host: string; meetingId: string }
export interface Chamadas { meet: number; tactiq: number; vertex: number }
export interface DocumentoGravado { patientId: string; label: string; originalFilename: string }

export class ResumoHarness {
  admin!: Pool;
  app!: AppDeFamilia;
  fx!: LiveFixtures;
  importer!: AdmissionImportService;
  sysCtx!: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  clock = T0;
  readonly meet = new FakeMeetConference();
  readonly mcp = new FakeTactiqMcp();
  readonly oauth = new FakeTactiqOAuth();
  readonly vault = new InMemoryTranscriptVault();
  readonly rehearsal = new InMemoryTranscriptVault();
  readonly vertex = new FakeAdmissionSummaryGenerator();
  readonly logs = capturingLogger();
  readonly docs: DocumentoGravado[] = [];
  private readonly envAnterior: Record<string, string | undefined> = {};
  private readonly runtimeUser: string;
  private readonly systemUser: string;

  /** `poolSistema`: conexões do pool de sistema (`DB_SYSTEM_POOL_MAX`). O do `docker-compose.test.yml` é 2; o padrão de produção é 5. */
  constructor(readonly conexao: ConexaoResumo, readonly sufixo: string, private readonly poolSistema = 5) {
    this.runtimeUser = `adm050rs_rt_${sufixo}`;
    this.systemUser = `adm050rs_sys_${sufixo}`;
  }

  at = (min: number): Date => new Date(T0.getTime() + min * MIN);

  private setEnv(k: string, v: string | undefined): void {
    if (!(k in this.envAnterior)) this.envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  async iniciar(): Promise<void> {
    this.admin = new Pool({ connectionString: DATABASE_URL });
    await ensureLoginRole(this.admin, this.runtimeUser, SENHA, 'app_runtime');
    await ensureLoginRole(this.admin, this.systemUser, SENHA, 'app_system');
    this.fx = new LiveFixtures(this.admin, this.sufixo, T0);
    await this.fx.iniciar();
    this.setEnv('DATABASE_URL', this.conexao === 'runtime' ? urlFor(DATABASE_URL, this.runtimeUser, SENHA) : DATABASE_URL);
    this.setEnv('DATABASE_SYSTEM_URL', this.conexao === 'runtime' ? urlFor(DATABASE_URL, this.systemUser, SENHA) : undefined);
    this.setEnv('COUNTRY_RLS_ENABLED', 'true');
    this.setEnv('USE_MOCK_AUTH', 'true');
    this.setEnv('DB_POOL_MAX', '4');
    this.setEnv('DB_SYSTEM_POOL_MAX', String(this.poolSistema));
    this.setEnv('INTERNAL_TOKEN_SECRET', SEGREDO);

    const [identity, { DatabaseConnection }, { withSystemDbContext }] = await Promise.all([
      import('@modules/identity'), import('@shared/database/DatabaseConnection'), import('@shared/database/requestDbSession'),
    ]);
    this.sysCtx = withSystemDbContext;
    const auth = new identity.AuthMiddleware(
      new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
      new identity.SimplifiedAuthorizationEngine(),
    );
    this.app = await montarAppDeFamilia({ auth, montarRotas: ({ app }) => this.montarRotas(app) });
  }

  private async montarRotas(express: import('express').Express): Promise<void> {
    const imp = async <T>(p: string): Promise<T> => import(`../../../src/modules/matching/${p}`) as Promise<T>;
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
    const { internalAuthMiddleware } = await import('@modules/notification');
    const { AdmissionEventRepository } = await imp<typeof import('../../../src/modules/matching/infrastructure/AdmissionEventRepository')>('infrastructure/AdmissionEventRepository');
    const { AdmissionPostCallRepository } = await imp<typeof import('../../../src/modules/matching/infrastructure/AdmissionPostCallRepository')>('infrastructure/AdmissionPostCallRepository');
    const { AdmissionPostCallJob } = await imp<typeof import('../../../src/modules/matching/application/AdmissionPostCallJob')>('application/AdmissionPostCallJob');
    const { AdmissionPostCallInternalController } = await imp<typeof import('../../../src/modules/matching/interfaces/controllers/AdmissionPostCallInternalController')>('interfaces/controllers/AdmissionPostCallInternalController');
    const { createAdmissionPostCallInternalRoutes } = await imp<typeof import('../../../src/modules/matching/interfaces/routes/admissionPostCallRoutes')>('interfaces/routes/admissionPostCallRoutes');
    const { AdmissionLiveJob } = await imp<typeof import('../../../src/modules/matching/application/AdmissionLiveJob')>('application/AdmissionLiveJob');
    const { AdmissionLiveRepository } = await imp<typeof import('../../../src/modules/matching/infrastructure/AdmissionLiveRepository')>('infrastructure/AdmissionLiveRepository');
    const { AdmissionLiveInternalController } = await imp<typeof import('../../../src/modules/matching/interfaces/controllers/AdmissionLiveInternalController')>('interfaces/controllers/AdmissionLiveInternalController');
    const { createAdmissionLiveInternalRoutes } = await imp<typeof import('../../../src/modules/matching/interfaces/routes/admissionLiveRoutes')>('interfaces/routes/admissionLiveRoutes');
    const { AdmissionFastSummaryStep } = await imp<typeof import('../../../src/modules/matching/application/AdmissionFastSummaryStep')>('application/AdmissionFastSummaryStep');
    const { AdmissionFastSummaryRepository } = await imp<typeof import('../../../src/modules/matching/infrastructure/AdmissionFastSummaryRepository')>('infrastructure/AdmissionFastSummaryRepository');
    const { AdmissionImportService } = await imp<typeof import('../../../src/modules/matching/application/AdmissionImportService')>('application/AdmissionImportService');
    const { AdmissionImportRepository } = await imp<typeof import('../../../src/modules/matching/infrastructure/AdmissionImportRepository')>('infrastructure/AdmissionImportRepository');
    const { AdmissionImportInternalController } = await imp<typeof import('../../../src/modules/matching/interfaces/controllers/AdmissionImportInternalController')>('interfaces/controllers/AdmissionImportInternalController');
    const { createAdmissionImportInternalRoutes } = await imp<typeof import('../../../src/modules/matching/interfaces/routes/admissionImportRoutes')>('interfaces/routes/admissionImportRoutes');
    const { TactiqLinkService } = await imp<typeof import('../../../src/modules/matching/application/TactiqLinkService')>('application/TactiqLinkService');
    const { TactiqLinkRepository } = await imp<typeof import('../../../src/modules/matching/infrastructure/TactiqLinkRepository')>('infrastructure/TactiqLinkRepository');

    const pool = DatabaseConnection.getInstance().getPool();
    const events = new AdmissionEventRepository(pool);
    const postCall = new AdmissionPostCallRepository(pool);
    const now = (): Date => this.clock;
    const link = new TactiqLinkService({
      repo: new TactiqLinkRepository(pool), oauth: this.oauth, mcp: this.mcp, cipher: { encrypt: async (p) => p, decrypt: async (c) => c },
      db: pool, log: this.logs.log, now,
    });
    const docs = this.docs;
    const documents = {
      prepare: async (i: { patientId: string; label: string; originalFilename: string }) => {
        docs.push({ patientId: i.patientId, label: i.label, originalFilename: i.originalFilename });
        return { commit: async () => ({ outcome: 'stored' as const, documentId: '00000000-0000-4000-8000-000000000028', sizeBytes: 1, sha256: 'x' }), discard: async () => undefined };
      },
    } as unknown as StoreAdmissionSummaryDocument;
    this.importer = new AdmissionImportService({
      repo: new AdmissionImportRepository(pool), events, tokens: link, mcp: this.mcp, vault: this.vault, rehearsalVault: this.rehearsal,
      summary: this.vertex, documents, db: pool, log: this.logs.log, now,
    });
    const rota = (ctx: string, router: import('express').Router) => express.use('/api/internal', systemContextMiddleware(ctx), internalAuthMiddleware, router);
    rota('job:admission-post-call', createAdmissionPostCallInternalRoutes(new AdmissionPostCallInternalController(
      new AdmissionPostCallJob({ repo: postCall, meet: this.meet, events, db: pool, log: this.logs.log, now }))));
    rota('job:admission-live', createAdmissionLiveInternalRoutes(new AdmissionLiveInternalController(new AdmissionLiveJob({
      live: new AdmissionLiveRepository(pool), postCall, meet: this.meet, events, db: pool, log: this.logs.log, now,
      fast: new AdmissionFastSummaryStep({ repo: new AdmissionFastSummaryRepository(), importer: this.importer, events, db: pool, log: this.logs.log }),
    }))));
    rota('job:admission-import', createAdmissionImportInternalRoutes(new AdmissionImportInternalController(this.importer)));
  }

  async encerrar(): Promise<void> {
    await this.app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await this.admin.query(`DELETE FROM tactiq_links WHERE host_email LIKE $1`, [`%.live.${this.sufixo}.%@example.test`]);
    await this.fx.limpar();
    await dropLoginRoles(this.admin, [this.runtimeUser, this.systemUser]);
    await this.admin.end();
    for (const [k, v] of Object.entries(this.envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /** Entre testes: tira as reuniões do teste anterior (uma `armed` esquecida seria lida de novo pelo job) e o vínculo delas. */
  async limparReunioes(): Promise<void> {
    await this.admin.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`%.live.${this.sufixo}.%@example.test`]);
    await this.admin.query(`DELETE FROM tactiq_links WHERE host_email LIKE $1`, [`%.live.${this.sufixo}.%@example.test`]);
  }

  /** Entre testes: esquece o programado e as chamadas. */
  reiniciarDubles(): void {
    this.meet.reset();
    this.mcp.reset();
    this.vertex.reset();
    this.vault.objects.clear();
    this.vault.putCalls.length = 0;
    this.rehearsal.objects.clear();
    this.rehearsal.putCalls.length = 0;
    this.docs.length = 0;
  }

  // ── rotas e relógio ──────────────────────────────────────────────────────────
  async chamar(rota: string, min: number): Promise<{ status: number; data: Record<string, number>; texto: string }> {
    this.clock = this.at(min);
    const res = await fetch(`${this.app.url}/api/internal/jobs/${rota}`, { method: 'POST', headers: { 'X-Internal-Secret': SEGREDO } });
    const texto = await res.text();
    let data: Record<string, number> = {};
    try { data = (JSON.parse(texto) as { data?: Record<string, number> }).data ?? {}; } catch { /* sem JSON */ }
    return { status: res.status, data, texto };
  }
  vivo = (min: number) => this.chamar('admission-live', min);
  rede = (min: number) => this.chamar('admission-post-call', min);
  importar = (min: number) => this.chamar('admission-import', min);

  // ── fixture ──────────────────────────────────────────────────────────────────
  /**
   * Reunião marcada (inicioMin..fimMin, em minutos de T0) com o responsável de vínculo VIVO no Tactiq e a reunião do Tactiq programada
   * com o código dela. `blocos(r, n)` muda o que o Tactiq devolve a cada leitura.
   */
  async reuniao(inicioMin: number, fimMin: number, extra: Partial<ReuniaoViva> = {}): Promise<ReuniaoResumo> {
    const id = await this.fx.semear({ inicioMin, fimMin, ...extra });
    const row = (await this.admin.query(`SELECT host_email, meet_link, admission_code, slot_start FROM admission_appointments WHERE id = $1`, [id])).rows[0];
    const host = row.host_email as string;
    await this.admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = lower($1)`, [host]);
    const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');
    await new TactiqLinkRepository(this.admin).upsertLinked({ email: host, uid: `e2e-050-rsm-${this.sufixo}`, tokenEncrypted: host, clientId: null, now: T0 });
    const r: ReuniaoResumo = { id, code: row.admission_code, meetCode: String(row.meet_link).split('/').pop() as string, host, meetingId: `tq-${row.admission_code}` };
    const item: TactiqMeetingItem = { id: r.meetingId, title: `${r.code} Admisión`, createdAt: new Date(row.slot_start).toISOString(), durationSeconds: 1800 };
    this.mcp.meetingsByToken.set(`at-${host}`, [item]);
    this.blocos(r, 3);
    return r;
  }

  /** O que o Tactiq devolve agora: `n` blocos de fala (0 = a reunião ainda não apareceu). `texto` entra em cada bloco. */
  blocos(r: ReuniaoResumo, n: number, texto = 'TEXTO-SINTETICO'): void {
    const token = `at-${r.host}`;
    const item = (this.mcp.meetingsByToken.get(token) ?? [])[0] ?? { id: r.meetingId, title: `${r.code} Admisión`, createdAt: this.at(0).toISOString(), durationSeconds: 1800 };
    this.mcp.meetingsByToken.set(token, n === 0 ? [] : [item]);
    const entries = Array.from({ length: n }, (_, i) => ({ text: `${texto} ${i}`, speaker: 'Operadora', startSeconds: i * 10, endSeconds: i * 10 + 9 }));
    this.mcp.pagesByMeeting.set(r.meetingId, [{ page: 1, totalPages: 1, totalChars: entries.reduce((s, e) => s + e.text.length, 0), hasMore: false, entries }]);
  }

  /** Conferência do Meet em minutos de T0 (`fim` null = aberta). */
  conf = (n: string, ini: number, fim: number | null) => ({ name: `conferenceRecords/${n}`, startTime: this.at(ini), endTime: fim === null ? null : this.at(fim) });
  conferencias = (r: ReuniaoResumo, ...c: Array<ReturnType<ResumoHarness['conf']>>): void => this.meet.setRecords(r.meetCode, c);

  // ── leituras ─────────────────────────────────────────────────────────────────
  row = async (id: string) => (await this.admin.query(
    `SELECT import_status, import_attempts, summary_fast_state, summary_fast_reads, summary_fast_last_count, summary_fast_last_read_at, conference_ended_at
       FROM admission_appointments WHERE id = $1`, [id])).rows[0];
  kinds = async (id: string): Promise<string[]> =>
    (await this.admin.query(`SELECT kind || coalesce(':' || reason, '') AS k FROM admission_events WHERE appointment_id = $1 ORDER BY at, kind`, [id])).rows.map((x) => x.k);
  count = async (id: string, kind: string): Promise<number> => (await this.kinds(id)).filter((k) => k === kind || k.startsWith(`${kind}:`)).length;
  chamadas = (): Chamadas => ({ meet: this.meet.listCalls.length, tactiq: this.mcp.searchCalls.length + this.mcp.transcriptCalls.length, vertex: this.vertex.received.length });
  pagas = (): number => this.logs.output().split('admission.paid_call').length - 1;
  importarDireto = (id: string, min: number, gate?: import('../../../src/modules/matching/application/AdmissionTranscriptReader').FastGate) => {
    this.clock = this.at(min);
    return this.sysCtx('job:admission-import', () => this.importer.importOne(id, this.at(min), gate));
  };
}
