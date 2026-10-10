/**
 * admissionRetryHarness — spec 050 F11 (R-38): "Reintentar resumen" provado com o PAPEL DO RUNTIME e o ENGINE DE PERMISSÃO LIGADO.
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (padrão do `admissionPaisHarness`): `-runtime` (login membro de
 * `app_runtime` + pool de sistema `app_system`, `COUNTRY_RLS_ENABLED=true`, como a API em stg/prd) e `-dono` (controle: a conexão do
 * dono do banco, que bypassa RLS). A lição da F10: escrita com `db.connect()` cru passa com o dono e é recusada no runtime
 * (`rls_session_without_identity`); por isso o POST de autorização e a volta da reunião à fila são provados nos DOIS.
 *
 * Só as fronteiras de terceiros são dublê: Tactiq (token e MCP) e Vertex. O cofre e o bucket de documentos são o código de verdade
 * contra o fake-gcs (`GCS_EMULATOR_HOST`). A importação roda pela ROTA do job (contexto de sistema), como no Cloud Scheduler.
 * Dados sintéticos; nenhum texto de transcrição/resumo em log ou trilha (provado em A11-1).
 *
 * A11-1 esgotada → autoriza → o job roda de novo → 1 documento · A11-2 dois cliques simultâneos → 1 autorização
 * A11-3 terceira autorização → 409 · A11-4 sem a célula → 403 · A11-5 reunião `done` → 409 · extra: motivo `prompt_*` só roda agora.
 */
import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import {
  grupoComCelulas, limparIamFixtures, montarAppDeFamilia, tokenMock, TENANT_E2E, type AppDeFamilia,
} from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeTactiqMcp } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeAdmissionSummaryGenerator } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { AdmissionSummaryError } from '../../../src/modules/matching/application/ports/AdmissionImportPorts';
import type { TactiqAccessResult, TactiqMeetingItem } from '../../../src/modules/matching/application/ports/TactiqPorts';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const FAKE_GCS_URL = process.env.GCS_EMULATOR_HOST || 'http://localhost:54443';

export type ConexaoRetry = 'runtime' | 'dono';

const SENHA = 'adm050_retry_pw';
const SECRET = 'test-secret-for-e2e-only';
const MIN = 60_000;
const TEXTO_CLINICO = 'TEXTO-CLINICO-SINTETICO-RETRY';

export function definirCenariosResumoRetry(conexao: ConexaoRetry, sufixo: string): void {
  const RUNTIME_USER = `adm050ret_rt_${sufixo}`;
  const SYSTEM_USER = `adm050ret_sys_${sufixo}`;
  const U = { com: `adm050-ret-com-${sufixo}`, sem: `adm050-ret-sem-${sufixo}` };
  const GRUPOS = { com: `Adm050 Retry Com ${sufixo}`, sem: `Adm050 Retry Sem ${sufixo}` };
  const RUN = `${Date.now().toString(36)}${sufixo}`;
  const VAULT_BUCKET = `f050r-vault-${RUN}`.toLowerCase();
  const DOCS_BUCKET = `f050r-docs-${RUN}`.toLowerCase();
  const CELULAS_049: Array<[string, string]> = [['patient_admission', 'read'], ['patient_admission', 'create'], ['patient_admission', 'update']];

  describe(`F11 — Reintentar resumen sob RLS e ABAC ligado, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let patientId = '';
    let seq = 0;
    const vertex = new FakeAdmissionSummaryGenerator();
    const mcp = new FakeTactiqMcp();
    const logs = capturingLogger();
    const envAnterior: Record<string, string | undefined> = {};
    const clock = new Date();
    /**
     * Barreira de A11-2: com ela ligada, quem chega à contagem espera (até 600 ms) a OUTRA requisição chegar. Sem o lock da reunião
     * as duas chegam juntas e as duas leem "esgotada" (2 autorizações); com o lock, a 2ª nem chega: a 1ª passa depois do prazo.
     */
    const barreira = { ligada: false, chegadas: 0 };
    async function esperarOutraRequisicao(): Promise<void> {
      if (!barreira.ligada) return;
      barreira.chegadas += 1;
      const ate = Date.now() + 600;
      while (barreira.chegadas < 2 && Date.now() < ate) await new Promise((r) => setTimeout(r, 10));
    }

    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    async function http(method: string, path: string, headers: Record<string, string>) {
      const res = await fetch(`${app.url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    }
    const runImportJob = () => http('POST', '/api/internal/jobs/admission-import', { 'X-Internal-Secret': SECRET });
    const retryUrl = (id: string) => `/api/admin/patients/${patientId}/admission-appointments/${id}/summary-retry`;
    const lista = async (uid: string) =>
      (await http('GET', `/api/admin/patients/${patientId}/admission-appointments`, { Authorization: tokenMock(uid, 'admin', 'AR') })).body.data as Array<{ id: string; summaryRetry: unknown }>;
    const clicar = (id: string, uid: string) => http('POST', retryUrl(id), { Authorization: tokenMock(uid, 'admin', 'AR') });

    /** Reunião `booked`, fim real há 80 min (fora do atraso de 10 min), importação pendente, Tactiq enxerga o código. */
    async function novaReuniao(): Promise<{ id: string; code: string }> {
      seq += 1;
      const start = new Date(clock.getTime() - 120 * MIN);
      const host = `op${seq}.${RUN}@example.test`;
      const code = `ADM-${(RUN + String(seq).padStart(3, '0')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6)}`;
      const { rows } = await admin.query(
        `INSERT INTO admission_appointments
           (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
            created_at, conference_ended_at, import_status)
         VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,'booked','https://meet.google.com/abc-defg-hij',$5,$6,$7,'pending') RETURNING id`,
        [patientId, host, start, new Date(start.getTime() + 30 * MIN), code, new Date(start.getTime() - 300 * MIN), new Date(clock.getTime() - 80 * MIN)],
      );
      const item: TactiqMeetingItem = { id: `tq-${code}`, title: `${code} Admisión`, createdAt: start.toISOString(), durationSeconds: 1800 };
      mcp.meetingsByToken.set(`at-${host}`, [item]);
      mcp.pagesByMeeting.set(item.id, [{
        page: 1, totalPages: 1, totalChars: TEXTO_CLINICO.length, hasMore: false,
        entries: [{ text: TEXTO_CLINICO, speaker: 'Operadora', startSeconds: 0, endSeconds: 9 }],
      }]);
      return { id: rows[0].id as string, code };
    }

    const events = async (id: string, kind: string) =>
      (await admin.query(`SELECT reason, outcome, ref FROM admission_events WHERE appointment_id = $1 AND kind = $2 ORDER BY at`, [id, kind])).rows as
        Array<{ reason: string | null; outcome: string | null; ref: Record<string, any> | null }>;
    const importStatus = async (id: string) => (await admin.query(`SELECT import_status FROM admission_appointments WHERE id = $1`, [id])).rows[0].import_status as string;
    const docs = async (id: string) => Number((await admin.query(`SELECT count(*) FROM patient_documents WHERE source_appointment_id = $1`, [id])).rows[0].count);
    const chamadasVertex = (code: string) => vertex.inputs.filter((i) => i.entrevistaId === code).length;

    /** Roda o job até a reunião ter `n` falhas do modelo (cada execução = 1 tentativa), mais UMA execução que registra a exaustão. */
    async function esgotar(id: string, code: string): Promise<void> {
      vertex.failWith = new AdmissionSummaryError('vertex_failed');
      const antes = chamadasVertex(code);
      for (let i = 0; i < 3; i += 1) expect((await runImportJob()).status).toBe(200);
      expect(chamadasVertex(code) - antes).toBe(3);
      expect((await runImportJob()).status).toBe(200); // a 4ª: o teto vale, 0 chamadas, `import_blocked`
      expect(chamadasVertex(code) - antes).toBe(3);
      expect(await importStatus(id)).toBe('blocked');
    }

    async function limpar(): Promise<void> {
      await admin.query(`DELETE FROM patient_documents WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id = $1)`, [`e2e-050-retry-${sufixo}`]);
      await admin.query(`DELETE FROM admission_appointments WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id = $1)`, [`e2e-050-retry-${sufixo}`]);
      await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-retry-${sufixo}`]);
      await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    }

    async function createBucket(name: string): Promise<void> {
      const res = await fetch(`${FAKE_GCS_URL}/storage/v1/b?project=enlite-test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (!res.ok && res.status !== 409) throw new Error(`fake-gcs: bucket ${name} -> ${res.status}`);
    }

    beforeAll(async () => {
      admin = new Pool({ connectionString: DATABASE_URL });
      await ensureLoginRole(admin, RUNTIME_USER, SENHA, 'app_runtime');
      await ensureLoginRole(admin, SYSTEM_USER, SENHA, 'app_system');
      await limpar();
      setEnv('DATABASE_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, RUNTIME_USER, SENHA) : DATABASE_URL);
      setEnv('DATABASE_SYSTEM_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, SYSTEM_USER, SENHA) : undefined);
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('USE_MOCK_AUTH', 'true');
      setEnv('DB_POOL_MAX', '4');
      setEnv('DB_SYSTEM_POOL_MAX', '2');
      setEnv('INTERNAL_TOKEN_SECRET', SECRET);
      setEnv('PERMISSION_ENGINE_ENABLED', 'true');
      setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
      setEnv('PERMISSION_CACHE_TTL_MS', '0');
      setEnv('GCS_EMULATOR_HOST', FAKE_GCS_URL);
      setEnv('GCP_PROJECT_ID', 'enlite-test');
      setEnv('PATIENT_DOCUMENTS_BUCKET', DOCS_BUCKET);
      setEnv('ADMISSION_TRANSCRIPT_VAULT_BUCKET', VAULT_BUCKET);
      await createBucket(VAULT_BUCKET);
      await createBucket(DOCS_BUCKET);

      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$3,'admin','ACTIVE',true,$5), ($2,$4,'admin','ACTIVE',true,$5)`,
        [U.com, U.sem, `${U.com}@e2e.local`, `${U.sem}@e2e.local`, TENANT_E2E],
      );
      await grupoComCelulas(admin, { nome: GRUPOS.com, uid: U.com, celulas: [...CELULAS_049, ['patient_admission', 'retry_summary']] });
      await grupoComCelulas(admin, { nome: GRUPOS.sem, uid: U.sem, celulas: CELULAS_049 });
      patientId = (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
         VALUES ($1,'Carla','Sintetico','AR',false,true,'+5491155550152') RETURNING id`,
        [`e2e-050-retry-${sufixo}`],
      )).rows[0].id;

      const [identity, { DatabaseConnection }] = await Promise.all([import('@modules/identity'), import('@shared/database/DatabaseConnection')]);
      const auth = new identity.AuthMiddleware(
        new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
        new identity.SimplifiedAuthorizationEngine(),
      );
      app = await montarAppDeFamilia({
        auth,
        enforcedRoutes: 'admin.patients',
        montarRotas: async ({ app: express, auth: authMw, permissions }) => {
          const { AdmissionImportService } = await import('../../../src/modules/matching/application/AdmissionImportService');
          const { AdmissionSummaryRetryService } = await import('../../../src/modules/matching/application/AdmissionSummaryRetryService');
          const { AdmissionPanelService } = await import('../../../src/modules/matching/application/AdmissionPanelService');
          const { AdmissionPanelController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionPanelController');
          const { createAdminAdmissionRoutes } = await import('../../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
          const { AdmissionImportInternalController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionImportInternalController');
          const { createAdmissionImportInternalRoutes } = await import('../../../src/modules/matching/interfaces/routes/admissionImportRoutes');
          const { AdmissionImportRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionImportRepository');
          const { AdmissionEventRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionEventRepository');
          const { GcsTranscriptVault } = await import('../../../src/modules/matching/infrastructure/GcsTranscriptVault');
          const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
          const { internalAuthMiddleware } = await import('@modules/notification');

          const pool = DatabaseConnection.getInstance().getPool();
          const repo = new AdmissionImportRepository(pool);
          const eventsRepo = new AdmissionEventRepository(pool);
          const tokens = {
            accessTokenFor: async (email: string): Promise<TactiqAccessResult> => ({ ok: true, accessToken: `at-${email}` }),
            markBroken: async () => true,
            markWrongAccount: async () => true,
          };
          const vault = new GcsTranscriptVault({ env: process.env, client: new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' }) });
          const importer = new AdmissionImportService({
            repo, events: eventsRepo, tokens, mcp, vault, summary: vertex, db: pool, log: logs.log, now: () => clock,
          });
          express.use('/api/admin', createAdminAdmissionRoutes(
            authMw, permissions,
            new AdmissionPanelController({} as never, new AdmissionPanelService({ db: pool } as never), new AdmissionSummaryRetryService({
              db: pool, events: eventsRepo, importer, log: logs.log,
              repo: {
                countRetryAuthorizations: (id, ex) => repo.countRetryAuthorizations(id, ex),
                summaryRetryFacts: (pid, ex) => repo.summaryRetryFacts(pid, ex),
                countModelSummaryFailures: async (id, ex) => {
                  await esperarOutraRequisicao();
                  return repo.countModelSummaryFailures(id, ex);
                },
              },
            })),
          ));
          express.use('/api/internal', systemContextMiddleware('job:admission-import'), internalAuthMiddleware,
            createAdmissionImportInternalRoutes(new AdmissionImportInternalController(importer)));
        },
      });
    }, 120000);

    beforeEach(() => {
      vertex.reset();
      mcp.reset();
    });

    afterAll(async () => {
      await app?.fechar();
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      await DatabaseConnection.getInstance().close();
      await limpar();
      await dropLoginRoles(admin, [RUNTIME_USER, SYSTEM_USER]);
      await admin.end();
      for (const [k, v] of Object.entries(envAnterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('0. sanidade: a conexão é a que o arquivo declara e, no runtime, a RLS está de pé (a conexão do runtime, sem identidade, é recusada)', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [patientId]);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBe(1);
    });

    it('A11-1: esgotada (3 chamadas pagas) → o job não chama mais o Vertex → autoriza → o job roda de novo → 1 documento, `done`, trilha com quem autorizou e sem texto', async () => {
      const a = await novaReuniao();
      await esgotar(a.id, a.code);
      vertex.failWith = null; // o Vertex "curou", mas o teto vale: controle de que a fila estava de fato fechada
      await runImportJob();
      expect(chamadasVertex(a.code)).toBe(3);
      expect(await docs(a.id)).toBe(0);

      const r = await clicar(a.id, U.com);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ appointmentId: a.id, mode: 'authorized', authorizationsUsed: 1, authorizationsLeft: 1 });
      expect(await importStatus(a.id)).toBe('waiting');
      const auth = await events(a.id, 'summary_retry_authorized');
      expect(auth).toHaveLength(1);
      expect(auth[0].ref).toMatchObject({ actorUid: U.com, authorization: 1 });

      expect((await runImportJob()).status).toBe(200);
      expect(chamadasVertex(a.code)).toBe(4);
      expect(await docs(a.id)).toBe(1);
      expect(await importStatus(a.id)).toBe('done');
      // a trilha é só-acréscimo: as 3 falhas e a exaustão continuam lá
      expect((await events(a.id, 'summary_failed')).length).toBe(3);
      expect((await events(a.id, 'import_blocked')).map((e) => e.reason)).toEqual(['summary_attempts_exhausted']);
      // nada de texto da transcrição em log ou trilha
      const trilha = JSON.stringify((await admin.query(`SELECT ref, reason, outcome FROM admission_events WHERE appointment_id = $1`, [a.id])).rows);
      expect(trilha).not.toContain(TEXTO_CLINICO);
      expect(logs.output()).not.toContain(TEXTO_CLINICO);
    });

    it('A11-2: dois cliques simultâneos → UMA autorização na trilha (o 2º só roda agora)', async () => {
      const a = await novaReuniao();
      await esgotar(a.id, a.code);
      barreira.ligada = true;
      barreira.chegadas = 0;
      const [r1, r2] = await Promise.all([clicar(a.id, U.com), clicar(a.id, U.com)]).finally(() => { barreira.ligada = false; });
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect([r1.body.data.mode, r2.body.data.mode].sort()).toEqual(['authorized', 'run_now']);
      expect(await events(a.id, 'summary_retry_authorized')).toHaveLength(1);
    });

    it('A11-3: a 3ª autorização → 409 e NADA muda (sem evento novo, a reunião segue fora da fila, 0 chamadas ao Vertex)', async () => {
      const a = await novaReuniao();
      await esgotar(a.id, a.code); // rodada 1
      expect((await clicar(a.id, U.com)).body.data.authorizationsUsed).toBe(1);
      await esgotar(a.id, a.code); // rodada 2 esgota de novo: a exaustão é gravada DE NOVO (desde a última autorização)
      expect((await events(a.id, 'import_blocked')).map((e) => e.reason)).toEqual(['summary_attempts_exhausted', 'summary_attempts_exhausted']);
      const segunda = await clicar(a.id, U.com);
      expect(segunda.body.data).toMatchObject({ mode: 'authorized', authorizationsUsed: 2, authorizationsLeft: 0 });
      await esgotar(a.id, a.code); // rodada 3 esgotada

      const chamadasAntes = chamadasVertex(a.code);
      const terceira = await clicar(a.id, U.com);
      expect(terceira.status).toBe(409);
      expect(terceira.body.code).toBe('SUMMARY_RETRY_LIMIT_REACHED');
      expect(await events(a.id, 'summary_retry_authorized')).toHaveLength(2);
      expect(await importStatus(a.id)).toBe('blocked');
      vertex.failWith = null;
      await runImportJob();
      expect(chamadasVertex(a.code)).toBe(chamadasAntes);
    });

    it('A11-4: sem a célula → 403 e nada muda; com a célula → 200 (controle: o 403 é da célula, não da rota)', async () => {
      const a = await novaReuniao();
      await esgotar(a.id, a.code);
      const negado = await clicar(a.id, U.sem);
      expect(negado.status).toBe(403);
      expect(await events(a.id, 'summary_retry_authorized')).toHaveLength(0);
      expect(await importStatus(a.id)).toBe('blocked');
      expect((await clicar(a.id, U.com)).status).toBe(200);
      expect(await events(a.id, 'summary_retry_authorized')).toHaveLength(1);
    });

    it('A11-5: reunião `done` → 409 e nenhum evento (controle: a mesma reunião esgotada antes era autorizável)', async () => {
      const a = await novaReuniao();
      vertex.failWith = null;
      await runImportJob();
      expect(await importStatus(a.id)).toBe('done');
      const r = await clicar(a.id, U.com);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('SUMMARY_RETRY_NOT_ALLOWED');
      expect(await events(a.id, 'summary_retry_authorized')).toHaveLength(0);
      expect(await docs(a.id)).toBe(1);
    });

    it('motivo `prompt_*` (não conta no teto): o botão só roda agora, SEM gastar autorização — e gera o documento quando o prompt volta', async () => {
      const a = await novaReuniao();
      vertex.failWith = new AdmissionSummaryError('prompt_missing');
      await runImportJob();
      expect((await events(a.id, 'summary_failed')).map((e) => e.reason)).toEqual(['prompt_missing']);
      const antes = chamadasVertex(a.code);

      const r1 = await clicar(a.id, U.com);
      expect(r1.status).toBe(200);
      expect(r1.body.data).toMatchObject({ mode: 'run_now', outcome: 'summary_failed', authorizationsUsed: 0, authorizationsLeft: 2 });
      expect(chamadasVertex(a.code)).toBe(antes + 1);

      vertex.failWith = null; // o prompt voltou
      const r2 = await clicar(a.id, U.com);
      expect(r2.body.data).toMatchObject({ mode: 'run_now', outcome: 'done' });
      expect(await docs(a.id)).toBe(1);
      expect(await events(a.id, 'summary_retry_authorized')).toHaveLength(0);
    });

    it('a lista da aba carrega o estado do botão: sem falha → null; `prompt_*` → só roda agora; esgotada → autoriza; teto gasto → 0 restantes (e o GET lê com o papel do runtime)', async () => {
      const a = await novaReuniao();
      const de = async () => (await lista(U.com)).find((r) => r.id === a.id)?.summaryRetry;
      expect(await de()).toBeNull(); // controle: reunião sem falha de resumo não tem botão
      vertex.failWith = new AdmissionSummaryError('prompt_missing');
      await runImportJob();
      expect(await de()).toEqual({ exhausted: false, authorizationsLeft: 2 });
      await esgotar(a.id, a.code);
      expect(await de()).toEqual({ exhausted: true, authorizationsLeft: 2 });
      await clicar(a.id, U.com);
      expect(await de()).toBeNull(); // rodada nova, nada falhou ainda nela
      vertex.failWith = new AdmissionSummaryError('prompt_missing');
      await runImportJob();
      expect(await de()).toEqual({ exhausted: false, authorizationsLeft: 1 }); // falha de prompt na rodada nova: NÃO está esgotada (as 3 de antes valem para a rodada de antes)
      await esgotar(a.id, a.code);
      expect(await de()).toEqual({ exhausted: true, authorizationsLeft: 1 });
      await clicar(a.id, U.com);
      await esgotar(a.id, a.code);
      expect(await de()).toEqual({ exhausted: true, authorizationsLeft: 0 });
      expect((await lista(U.sem)).find((r) => r.id === a.id)?.summaryRetry).toEqual({ exhausted: true, authorizationsLeft: 0 }); // o campo é de leitura: quem lê a aba o recebe; a TELA esconde o botão sem a célula
    });

    it('reunião de outro paciente ou inexistente → 404 (o id da URL manda no paciente)', async () => {
      const a = await novaReuniao();
      const outro = await http('POST', `/api/admin/patients/00000000-0000-4000-8000-0000000000aa/admission-appointments/${a.id}/summary-retry`, { Authorization: tokenMock(U.com, 'admin', 'AR') });
      expect(outro.status).toBe(404);
      const sumida = await clicar('00000000-0000-4000-8000-0000000000bb', U.com);
      expect(sumida.status).toBe(404);
    });
  });
}
