/**
 * client-policy-worker-documents.e2e.test.ts — as 10 rotas de prestador que não passavam pelo `requirePermission`
 * (9 de `workerDocumentsRoutes`, 1 de `workerApplicationsRoutes`) agora decididas pelo Cedar do cliente
 * (acesso-do-cliente, F3, T311, AJUSTE A14). Documento é parte da ficha: `worker:read|update` → `ReadOwnWorkerProfile|UpdateOwnWorkerProfile`.
 *
 * HTTP real em processo, banco real, motores reais (`createClientPolicyEngine` + `StaffOrClientEngine` + `GroupPermissionEngine`),
 * os DOIS routers REAIS com os controllers REAIS, como no `index.ts`. Side-effect outbound mapeado antes: GCS (assinar URL / apagar
 * objeto) — `GCSStorageService` roda em modo simulado (NODE_ENV=test e sem GCP_PROJECT_ID → nenhum bucket, nenhuma rede); os corpos
 * usados não chegam a Talentum/WhatsApp (`track-channel` recebe corpo inválido → 400 antes do caso de uso). Fixtures sintéticas, sem PII.
 * Nenhuma das 10 rotas aceita id de OUTRO prestador no caminho; "A sobre B" = id de documento de B e header de B (nenhum age em B).
 */
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const DOC_ID = '00000000-0000-4000-8000-000000000099';

/** [método, caminho (`:doc` = id de documento adicional), corpo, status esperado do só-prestador]. */
const ROTAS: Array<[string, string, unknown, number]> = [
  ['GET', '/api/workers/me/documents', undefined, 200],
  ['POST', '/api/workers/me/documents/upload-url', { docType: 'resume_cv' }, 200],
  ['POST', '/api/workers/me/documents/save', {}, 400],
  ['POST', '/api/workers/me/documents/view-url', {}, 400],
  ['DELETE', '/api/workers/me/documents/resume_cv', undefined, 200],
  ['GET', '/api/workers/me/additional-documents', undefined, 200],
  ['POST', '/api/workers/me/additional-documents/upload-url', {}, 200],
  ['POST', '/api/workers/me/additional-documents', {}, 400],
  // doc inexistente: o repositório lança e o controller responde 500 (comportamento anterior, fora desta task) — a autorização já passou
  ['DELETE', '/api/workers/me/additional-documents/:doc', undefined, 500],
  ['POST', '/api/worker-applications/track-channel', {}, 400],
];

for (const modo of ['A_flag_desligada', 'B_flag_ligada'] as const) {
  describe(`10 rotas de prestador no Cedar — ${modo}`, () => {
    let pool: Pool;
    let app: AppDeFamilia;
    const envAnterior: Record<string, string | undefined> = {};
    const ligada = modo.startsWith('B');
    let seq = 0;

    beforeAll(async () => {
      const set = { USE_MOCK_AUTH: 'true', DATABASE_URL, PERMISSION_ENGINE_ENABLED: ligada ? 'true' : 'false', NODE_ENV: 'test' };
      for (const [k, v] of Object.entries(set)) { envAnterior[k] = process.env[k]; process.env[k] = v; }
      for (const k of ['GOOGLE_IDENTITY_API_KEY', 'GCP_PROJECT_ID', 'DISABLE_GCS_MOCK']) { envAnterior[k] = process.env[k]; delete process.env[k]; }
      pool = new Pool({ connectionString: DATABASE_URL });
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const identity = await import('@modules/identity');
      const { createPermissionsModule } = await import('@modules/identity/permissions');
      const { createClientPolicyEngine } = await import('@modules/identity/clientAuthorization/createClientPolicyEngine');
      const { StaffOrClientEngine, staffGroupGoverns } = await import('@modules/identity/clientAuthorization/StaffOrClientEngine');
      const db = DatabaseConnection.getInstance();
      const pm = createPermissionsModule({ pool: db.getPool(), systemPool: db.getSystemPool(), ttlMs: 0, engineEnabled: ligada });
      const nonGoverned = new StaffOrClientEngine(new identity.SimplifiedAuthorizationEngine(), createClientPolicyEngine(db.getPool()));
      const declaradas = new Set(['worker:read', 'worker:update']);
      const engine = ligada
        ? new identity.GroupPermissionEngine(pm.client, nonGoverned, { governsCell: staffGroupGoverns((r, a) => declaradas.has(`${r}:${a}`)) })
        : nonGoverned;
      const auth = new identity.AuthMiddleware({ parseCredentials: () => null, authenticate: async () => null } as never, engine as never, pm.client);
      app = await montarAppDeFamilia({
        auth,
        montarRotas: ({ app: x, permissions }) => {
          const { WorkerDocumentsMeController, WorkerAdditionalDocsMeController, AdminAdditionalDocsController, createWorkerDocumentsRoutes } = require('@modules/worker');
          const { createWorkerApplicationsRoutes, WorkerApplicationsController } = require('@modules/matching');
          // sonda: o MESMO guard das 10 rotas (`requireAuth` + `requirePermission('worker', …)`) numa rota que, ao contrário delas, recebe
          // a ficha no caminho (`:id`) — única forma de pôr o Cedar diante de uma ficha ALHEIA por HTTP (nenhuma das 10 aceita id de prestador)
          x.get('/api/probe/workers/:id', auth.requireAuth(), auth.requirePermission('worker', 'read'), (_q: any, s: any) => s.status(200).json({ ok: true }));
          x.use('/api', createWorkerApplicationsRoutes(new WorkerApplicationsController(), auth));
          x.use('/api', createWorkerDocumentsRoutes(new WorkerDocumentsMeController(), new WorkerAdditionalDocsMeController(), new AdminAdditionalDocsController(), auth, permissions));
        },
      });
    }, 30000);

    afterAll(async () => {
      await app?.fechar();
      await pool.query(`DELETE FROM worker_additional_documents WHERE worker_id IN (SELECT id FROM workers WHERE auth_uid LIKE $1)`, [`e2e-wdocs-${RUN}-%`]);
      await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`e2e-wdocs-${RUN}-%`]);
      await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`e2e-wdocs-${RUN}-%`]);
      await pool.end();
      for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    });

    async function criar(tipo: 'so-prestador' | 'staff+prestador' | 'sem-ficha'): Promise<{ uid: string; workerId: string | null }> {
      seq += 1;
      const u = `e2e-wdocs-${RUN}-${seq}`;
      let workerId: string | null = null;
      if (tipo !== 'sem-ficha') {
        const r = await pool.query(
          `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW()) RETURNING id`,
          [u, `${u}@e2e.local`, `+54911${String(seq).padStart(4, '0')}${RUN.slice(0, 4).replace(/[a-f]/g, '7')}`],
        );
        workerId = r.rows[0].id;
      }
      if (tipo !== 'so-prestador') {
        await pool.query(
          `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
           VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
          [u, `${u}@e2e.local`],
        );
      }
      return { uid: u, workerId };
    }

    async function chamar(u: string, role: string, metodo: string, caminho: string, corpo: unknown, extra: Record<string, string> = {}) {
      const res = await fetch(`${app.url}${caminho.replace(':doc', DOC_ID)}`, {
        method: metodo,
        headers: { Authorization: tokenMock(u, role), ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...extra },
        ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      });
      const texto = await res.text();
      let j: any = {};
      try { j = JSON.parse(texto); } catch { /* html */ }
      return { status: res.status, reason: String(j.reason ?? ''), body: j };
    }

    it('prestador A sobre a PRÓPRIA ficha nas 10 rotas → a autorização passa (status = o do handler, nunca 401/403)', async () => {
      const a = await criar('so-prestador');
      for (const [metodo, caminho, corpo, esperado] of ROTAS) {
        const r = await chamar(a.uid, 'worker', metodo, caminho, corpo);
        expect([`${metodo} ${caminho}`, r.status]).toEqual([`${metodo} ${caminho}`, esperado]);
      }
    }, 90000);

    it('staff + prestador sobre si nas 10 rotas → igual ao só-prestador (DF-1/DF-4: o vínculo manda, não o grupo)', async () => {
      const s = await criar('staff+prestador');
      for (const [metodo, caminho, corpo, esperado] of ROTAS) {
        const r = await chamar(s.uid, 'admin', metodo, caminho, corpo);
        expect([`${metodo} ${caminho}`, r.status, r.reason]).toEqual([`${metodo} ${caminho}`, esperado, '']);
      }
    }, 90000);

    it('sem ficha de prestador (conta sem vínculo care·worker) → 403 nas 10 rotas, inclusive staff (DF-4)', async () => {
      const sem = await criar('sem-ficha');
      for (const [metodo, caminho, corpo] of ROTAS) {
        const r = await chamar(sem.uid, 'worker', metodo, caminho, corpo);
        expect([`${metodo} ${caminho}`, r.status]).toEqual([`${metodo} ${caminho}`, 403]);
      }
      const staffSemFicha = await criar('sem-ficha');
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
         VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
        [`${staffSemFicha.uid}-s`, `${staffSemFicha.uid}-s@e2e.local`],
      );
      const r = await chamar(`${staffSemFicha.uid}-s`, 'admin', 'GET', '/api/workers/me/documents', undefined);
      expect(r.status).toBe(403);
    }, 90000);

    it('A sobre B (ficha alheia no caminho, mesmo guard) → 403; A sobre a própria ficha → 200; staff+prestador sobre B → 403', async () => {
      const a = await criar('so-prestador');
      const b = await criar('so-prestador');
      const s = await criar('staff+prestador');
      expect((await chamar(a.uid, 'worker', 'GET', `/api/probe/workers/${b.workerId}`, undefined)).status).toBe(403);
      expect((await chamar(a.uid, 'worker', 'GET', `/api/probe/workers/${a.workerId}`, undefined)).status).toBe(200);
      expect((await chamar(s.uid, 'admin', 'GET', `/api/probe/workers/${s.workerId}`, undefined)).status).toBe(200);
      expect((await chamar(s.uid, 'admin', 'GET', `/api/probe/workers/${b.workerId}`, undefined)).status).toBe(403);
    }, 60000);

    it('A sobre B: id de documento de B e header x-auth-uid de B não alcançam B (a ficha é a do token)', async () => {
      const a = await criar('so-prestador');
      const b = await criar('so-prestador');
      const doc = await pool.query(
        `INSERT INTO worker_additional_documents (worker_id, label, file_path) VALUES ($1, 'doc-sintetico', $2) RETURNING id`,
        [b.workerId, `workers/${b.workerId}/additional/sintetico.pdf`],
      );
      const docB = doc.rows[0].id as string;
      // A tenta apagar o id do doc de B: a autorização passa (é a ficha de A), mas o repositório filtra por worker_id = A → não achou
      // (500 do controller, comportamento anterior) e o doc de B continua
      const del = await chamar(a.uid, 'worker', 'DELETE', `/api/workers/me/additional-documents/${docB}`, undefined, { 'x-auth-uid': b.uid });
      expect(del.status).toBe(500);
      const aindaB = await pool.query(`SELECT count(*)::int AS n FROM worker_additional_documents WHERE id = $1`, [docB]);
      expect(aindaB.rows[0].n).toBe(1);
      // A lista com o header de B: vê os próprios (0), nunca o de B
      const lista = await chamar(a.uid, 'worker', 'GET', '/api/workers/me/additional-documents', undefined, { 'x-auth-uid': b.uid });
      expect(lista.status).toBe(200);
      expect(lista.body.data).toEqual([]);
      // B sem token de B (token de A) nunca vira B; e o token de B enxerga o doc dele
      const listaB = await chamar(b.uid, 'worker', 'GET', '/api/workers/me/additional-documents', undefined);
      expect(listaB.body.data.map((d: { id: string }) => d.id)).toEqual([docB]);
    }, 60000);
  });
}

afterAll(async () => {
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
});
