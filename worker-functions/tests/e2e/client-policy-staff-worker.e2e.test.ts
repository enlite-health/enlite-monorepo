/**
 * client-policy-staff-worker.e2e.test.ts — staff + prestador nas 12 rotas, com a fiação REAL do `index.ts`
 * (acesso-do-cliente, F2, T215, fase-2.md item 6, DF-1/DF-4, AJUSTE A8). Compara com a linha de base T201
 * (`evidencias/f2-baseline-12-rotas.md`): ali, com o engine ligado (stg/prd), a conta staff que também é prestador levava
 * 403 "Sem a permissão worker:*" no PRÓPRIO recurso em 10 das 12 rotas.
 *
 * HTTP real em processo, banco real, motores reais: `createClientPolicyEngine` (Cedar) + `StaffOrClientEngine` + (montagem B)
 * `GroupPermissionEngine` com `staffGroupGoverns`, exatamente como o `index.ts`. Duas montagens: A = flag desligada;
 * B = flag ligada (como stg/prd). Só o `AccountLinkService` é dublê (ele enviaria OTP/e-mail); Firebase Admin não é tocado
 * (sem credencial Identity o DELETE responde 400 sem rede). Fixtures sintéticas, sem PII; conta NOVA por chamada.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');

/** [método, caminho, corpo, status esperado da conta só-prestador = linha de base T201 (a autorização passa e o handler responde)]. */
const ROTAS: Array<[string, string, unknown, number]> = [
  ['PUT', '/api/workers/step', { step: 1 }, 400],
  ['GET', '/api/workers/me', undefined, 200],
  ['PUT', '/api/workers/me/general-info', {}, 200],
  ['PUT', '/api/workers/me/service-area', {}, 400],
  ['GET', '/api/workers/me/availability', undefined, 200],
  ['PUT', '/api/workers/me/availability', { availability: [] }, 400],
  ['DELETE', '/api/users/me', undefined, 400],
  ['DELETE', '/api/users/:self', undefined, 403],
  ['POST', '/api/workers/me/account-link/lookup', { phone: '+5491100000000' }, 200],
  ['POST', '/api/workers/me/account-link/start', { phone: '+5491100000000' }, 200],
  ['POST', '/api/workers/me/account-link/confirm', { phone: '+5491100000000', verificationSid: 'x', otp: '0' }, 200],
  ['POST', '/api/workers/me/account-link/finalize', {}, 401],
];
const STAFF_ONLY = 'DELETE /api/users/:self';

const linhas: Array<{ modo: string; rota: string; conta: string; status: number; razao: string }> = [];
let seq = 0;

for (const modo of ['A_flag_desligada', 'B_flag_ligada'] as const) {
  describe(`staff + prestador × só-prestador — ${modo}`, () => {
    let pool: Pool;
    let app: AppDeFamilia;
    const envAnterior: Record<string, string | undefined> = {};
    const ligada = modo.startsWith('B');

    beforeAll(async () => {
      const set = { USE_MOCK_AUTH: 'true', DATABASE_URL, ACCOUNT_LINK_ENABLED: 'true', PERMISSION_ENGINE_ENABLED: ligada ? 'true' : 'false' };
      for (const [k, v] of Object.entries(set)) { envAnterior[k] = process.env[k]; process.env[k] = v; }
      for (const k of ['GOOGLE_IDENTITY_API_KEY', 'GCP_PROJECT_ID']) { envAnterior[k] = process.env[k]; delete process.env[k]; }
      pool = new Pool({ connectionString: DATABASE_URL });
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const identity = await import('@modules/identity');
      const { createPermissionsModule } = await import('@modules/identity/permissions');
      const { createClientPolicyEngine } = await import('@modules/identity/clientAuthorization/createClientPolicyEngine');
      const { StaffOrClientEngine, staffGroupGoverns } = await import('@modules/identity/clientAuthorization/StaffOrClientEngine');
      const db = DatabaseConnection.getInstance();
      const pm = createPermissionsModule({ pool: db.getPool(), systemPool: db.getSystemPool(), ttlMs: 0, engineEnabled: ligada });
      // Mesma composição do index.ts: legado de staff + plano do cliente; com a flag, o GroupPermissionEngine por cima.
      const nonGoverned = new StaffOrClientEngine(new identity.SimplifiedAuthorizationEngine(), createClientPolicyEngine(db.getPool()));
      // células que as rotas admin declaram hoje (worker:read/update; user:* não são declaradas) — como na linha de base
      const declaradas = new Set(['worker:read', 'worker:update']);
      const engine = ligada
        ? new identity.GroupPermissionEngine(pm.client, nonGoverned, { governsCell: staffGroupGoverns((r, a) => declaradas.has(`${r}:${a}`)) })
        : nonGoverned;
      const auth = new identity.AuthMiddleware({ parseCredentials: () => null, authenticate: async () => null } as never, engine as never, pm.client);
      app = await montarAppDeFamilia({
        auth,
        montarRotas: ({ app: x }) => {
          const { WorkerControllerV2 } = require('@modules/worker/interfaces/controllers/WorkerControllerV2');
          const { UserController } = require('@modules/identity/interfaces/controllers/UserController');
          const { AccountLinkController } = require('@modules/account-link/AccountLinkController');
          const { createAccountLinkRoutes } = require('@modules/account-link/accountLinkRoutes');
          const w = new WorkerControllerV2();
          const u = new UserController();
          // MESMA ordem/guards de src/index.ts (476-499)
          x.put('/api/workers/step', auth.requireAuth(), auth.requirePermission('worker', 'update'), (q: any, s: any) => w.saveStep(q, s));
          x.get('/api/workers/me', auth.requireAuth(), auth.requirePermission('worker', 'read'), (q: any, s: any) => w.getProgress(q, s));
          x.put('/api/workers/me/general-info', auth.requireAuth(), auth.requirePermission('worker', 'update'), (q: any, s: any) => w.saveGeneralInfo(q, s));
          x.put('/api/workers/me/service-area', auth.requireAuth(), auth.requirePermission('worker', 'update'), (q: any, s: any) => w.saveServiceArea(q, s));
          x.get('/api/workers/me/availability', auth.requireAuth(), auth.requirePermission('worker', 'read'), (q: any, s: any) => w.getAvailability(q, s));
          x.put('/api/workers/me/availability', auth.requireAuth(), auth.requirePermission('worker', 'update'), (q: any, s: any) => w.saveAvailability(q, s));
          x.delete('/api/users/me', auth.requireAuth(), auth.requirePermission('user', 'delete'), (q: any, s: any) => u.deleteUser(q, s));
          x.delete('/api/users/:userId', auth.requireStaff(), auth.requirePermission('user', 'admin_delete'), (q: any, s: any) => u.deleteUserById(q, s));
          // dublê só do service (enviaria OTP/e-mail); controller, rotas, rate-limit e guards são reais
          const ok = async () => ({});
          x.use('/api', createAccountLinkRoutes(new AccountLinkController(db.getPool(), { lookup: ok, start: ok, confirm: ok, finalize: ok }), auth));
        },
      });
    }, 30000);

    afterAll(async () => {
      await app?.fechar();
      await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`e2e-staffprest-${RUN}-%`]);
      await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`e2e-staffprest-${RUN}-%`]);
      await pool.end();
      for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    });

    async function conta(tipo: 'so-prestador' | 'staff+prestador'): Promise<string> {
      seq += 1;
      const u = `e2e-staffprest-${RUN}-${seq}`;
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
        [u, `${u}@e2e.local`, `+54911${String(seq).padStart(4, '0')}${RUN.slice(0, 4).replace(/[a-f]/g, '7')}`],
      );
      if (tipo === 'staff+prestador') {
        await pool.query(
          `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
           VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
          [u, `${u}@e2e.local`],
        );
      }
      return u;
    }

    async function chamar(tipo: 'so-prestador' | 'staff+prestador', metodo: string, caminho: string, corpo: unknown) {
      const u = await conta(tipo);
      const res = await fetch(`${app.url}${caminho.replace(':self', u)}`, {
        method: metodo,
        headers: { Authorization: tokenMock(u, tipo === 'so-prestador' ? 'worker' : 'admin'), ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
        ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      });
      const texto = await res.text();
      let j: any = {};
      try { j = JSON.parse(texto); } catch { /* html */ }
      linhas.push({ modo, rota: `${metodo} ${caminho}`, conta: tipo, status: res.status, razao: String(j.reason ?? j.error ?? j.code ?? '').slice(0, 60) });
      return { status: res.status, reason: String(j.reason ?? '') };
    }

    it('as 12 rotas × {só-prestador, staff+prestador}: só-prestador = linha de base; staff+prestador = só-prestador (exceto DELETE /api/users/:userId, que é staff)', async () => {
      for (const [metodo, caminho, corpo, esperado] of ROTAS) {
        const rota = `${metodo} ${caminho}`;
        const so = await chamar('so-prestador', metodo, caminho, corpo);
        const st = await chamar('staff+prestador', metodo, caminho, corpo);
        expect([rota, 'so-prestador', so.status]).toEqual([rota, 'so-prestador', esperado]);
        if (rota === STAFF_ONLY) {
          // staff+prestador passa o guard e a autorização (≠ 403); o 400 vem da falta de credencial Identity no teste
          expect([rota, 'staff+prestador', st.status]).toEqual([rota, 'staff+prestador', 400]);
        } else {
          expect([rota, 'staff+prestador', st.status, st.reason]).toEqual([rota, 'staff+prestador', esperado, '']);
        }
      }
    }, 90000);

    it('DF-4: o acesso vem do vínculo, não do account_type — staff SEM ficha de prestador → 403 nas rotas /me', async () => {
      seq += 1;
      const u = `e2e-staffprest-${RUN}-${seq}`;
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
         VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
        [u, `${u}@e2e.local`],
      );
      const res = await fetch(`${app.url}/api/workers/me`, { headers: { Authorization: tokenMock(u, 'admin') } });
      expect(res.status).toBe(403);
    }, 30000);
  });
}

afterAll(async () => {
  if (process.env.F2_TABELA_SAIDA) fs.writeFileSync(process.env.F2_TABELA_SAIDA, JSON.stringify(linhas, null, 1));
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
});
