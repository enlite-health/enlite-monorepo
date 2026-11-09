/**
 * area-membership-admin.e2e.test.ts — rotas de staff do registro de vínculos de área, HTTP REAL + banco REAL, engine
 * ABAC LIGADO em `admin.users` (acesso-do-cliente, F1, T111; fase-1 item 5, parte e2e).
 *
 * Mesmo molde de `me-areas-route.e2e.test.ts` (cadeia real correlation → dbSession → mockAuth → AuthMiddleware →
 * PermissionMiddleware → rota, numa porta efêmera) e de `admission-049-tactiq-link.e2e.test.ts` (grupo com células).
 * A ÚNICA substituição é o Firebase Admin (dublê em memória de `getUser`/`setCustomUserClaims`/`revokeRefreshTokens`).
 *
 * As células `area_membership:read|write` são dadas aos usuários de TESTE aqui dentro (fixture: grupo + vínculo), nunca por
 * migration nem a grupo real. Se a célula ainda não existe em `iam.permissions` (catálogo não sincronizado no job do CI),
 * `garantirCelulas` a cria e o `afterAll` a remove.
 * `iam.*` do registro é append-only (sem DELETE): os uids levam sufixo aleatório por execução. Fixtures sintéticas, sem PII.
 */
import { randomBytes } from 'crypto';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  garantirCelulas,
  removerCelulasCriadas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const U = {
  editor: `e2e-amadm-${RUN}-editor`, // area_membership: read + write
  leitor: `e2e-amadm-${RUN}-leitor`, // area_membership: read
  semGrupo: `e2e-amadm-${RUN}-sem-grupo`, // staff ativo sem nenhuma célula
  aluno: `e2e-amadm-${RUN}-aluno`, // a pessoa que recebe o vínculo (login de prestador/cliente)
};
const GRUPOS = { editor: `AmAdm Editor ${RUN}`, leitor: `AmAdm Leitor ${RUN}` };
const emailOf = (uid: string): string => `${uid}@e2e.local`;
const UUID_INEXISTENTE = '00000000-0000-4000-8000-00000000dead';

type Claims = Record<string, unknown>;

describe('rotas de staff de vínculo de área — HTTP real, banco real, engine LIGADO (acesso-do-cliente F1)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let celulasCriadas: string[] = [];
  let pid: string;
  let revogacoesDeSessao = 0;
  const claims = new Map<string, Claims>();
  const envAnterior: Record<string, string | undefined> = {};

  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  async function http(method: string, path: string, uid: string | null, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  const aluno = async (): Promise<{ status: number; body: Record<string, any> }> => {
    const res = await fetch(`${app.url}/v1/me/areas`, { headers: { Authorization: tokenMock(U.aluno, 'worker', 'AR') } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const vivos = async (): Promise<number> =>
    Number((await admin.query(`SELECT count(*) AS n FROM iam.area_membership WHERE person_id = $1 AND revoked_at IS NULL`, [pid])).rows[0].n);
  const totalLinhas = async (): Promise<number> =>
    Number((await admin.query(`SELECT count(*) AS n FROM iam.area_membership WHERE person_id = $1`, [pid])).rows[0].n);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(admin, { uids: [U.editor, U.leitor, U.semGrupo], grupos: Object.values(GRUPOS) });
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
      getUser: async (u: string) => ({ uid: u, email: emailOf(u), customClaims: claims.get(u) ?? {} }),
      setCustomUserClaims: async (u: string, c: Claims) => void claims.set(u, c),
      revokeRefreshTokens: async () => void (revogacoesDeSessao += 1),
    })) as never);

    for (const u of [U.editor, U.leitor, U.semGrupo]) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`,
        [u, emailOf(u), TENANT_E2E],
      );
    }
    celulasCriadas = await garantirCelulas(admin, ['area_membership:read', 'area_membership:write'], 'Administração');
    await grupoComCelulas(admin, { nome: GRUPOS.editor, uid: U.editor, celulas: [['area_membership', 'read'], ['area_membership', 'write']] });
    await grupoComCelulas(admin, { nome: GRUPOS.leitor, uid: U.leitor, celulas: [['area_membership', 'read']] });
    pid = (await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [U.aluno])).rows[0].p;

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: ({ app: expressApp, auth, permissions }) => {
        const { createAdminAreaMembershipRoutes, AreaMembershipController } = require('@modules/identity');
        const { createMeAreasRouter } = require('@modules/identity/interfaces/meAreasRoute');
        const pool = require('@shared/database/DatabaseConnection').DatabaseConnection.getInstance().getPool();
        expressApp.use('/api/admin', createAdminAreaMembershipRoutes(auth, permissions, AreaMembershipController.fromPool(pool)));
        expressApp.use('/v1', createMeAreasRouter(auth.requireAuth(), pool));
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limparIamFixtures(admin, { uids: [U.editor, U.leitor, U.semGrupo], grupos: Object.values(GRUPOS) });
    await removerCelulasCriadas(admin, celulasCriadas);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('403 sem a célula: staff sem grupo não lê, não concede, não revoga (banco inalterado)', async () => {
    expect((await http('GET', `/api/admin/area-memberships?personId=${pid}`, U.semGrupo)).status).toBe(403);
    expect((await http('POST', '/api/admin/area-memberships', U.semGrupo, { personId: pid, area: 'learn', role: 'learner' })).status).toBe(403);
    expect((await http('POST', `/api/admin/area-memberships/${UUID_INEXISTENTE}/revoke`, U.semGrupo, { reason: 'x' })).status).toBe(403);
    expect(await totalLinhas()).toBe(0);
  });

  it('403 só com `read`: lista (200), mas conceder e revogar são negados', async () => {
    expect((await http('GET', `/api/admin/area-memberships?personId=${pid}`, U.leitor)).status).toBe(200);
    expect((await http('POST', '/api/admin/area-memberships', U.leitor, { personId: pid, area: 'learn', role: 'learner' })).status).toBe(403);
    expect((await http('POST', `/api/admin/area-memberships/${UUID_INEXISTENTE}/revoke`, U.leitor, { reason: 'x' })).status).toBe(403);
    expect(await totalLinhas()).toBe(0);
  });

  it('com `write`: 201 ao conceder, grava o ator, e o grant aparece em GET /v1/me/areas da pessoa', async () => {
    const before = await aluno();
    expect(before.body.areas).toEqual([]);

    const r = await http('POST', '/api/admin/area-memberships', U.editor, { personId: pid, area: 'learn', role: 'learner' });
    expect(r.status).toBe(201);
    expect(typeof r.body.data.membershipId).toBe('string');
    const linha = (await admin.query(`SELECT area, role, granted_by FROM iam.area_membership WHERE id = $1`, [r.body.data.membershipId])).rows[0];
    expect(linha).toEqual({ area: 'learn', role: 'learner', granted_by: U.editor });

    const depois = await aluno();
    expect(depois.body.areas).toEqual([{ area: 'learn', role: 'learner', entryRoute: null }]);
  });

  it('GET: por `personId` e por `?uid=` (resolve_person) devolvem a mesma pessoa e o vínculo vivo; parâmetro errado → 400/404', async () => {
    const porPid = await http('GET', `/api/admin/area-memberships?personId=${pid}`, U.leitor);
    const porUid = await http('GET', `/api/admin/area-memberships?uid=${U.aluno}`, U.leitor);
    expect(porPid.status).toBe(200);
    expect(porUid.body.data.personId).toBe(pid);
    expect(porPid.body.data.memberships.map((m: any) => [m.area, m.role, m.grantedBy])).toEqual([['learn', 'learner', U.editor]]);
    expect(porUid.body.data.memberships).toHaveLength(1);

    expect((await http('GET', `/api/admin/area-memberships`, U.leitor)).status).toBe(400);
    expect((await http('GET', `/api/admin/area-memberships?personId=${pid}&uid=${U.aluno}`, U.leitor)).status).toBe(400);
    expect((await http('GET', `/api/admin/area-memberships?personId=nao-e-uuid`, U.leitor)).status).toBe(400);
    expect((await http('GET', `/api/admin/area-memberships?uid=${U.aluno}-inexistente`, U.leitor)).status).toBe(404);
  });

  it('POST: par fora do registro → 422 e corpo inválido → 400, sem gravar', async () => {
    const antes = await totalLinhas();
    expect((await http('POST', '/api/admin/area-memberships', U.editor, { personId: pid, area: 'care', role: 'worker' })).status).toBe(422);
    expect((await http('POST', '/api/admin/area-memberships', U.editor, { personId: 'x', area: 'learn', role: 'learner' })).status).toBe(400);
    expect((await http('POST', '/api/admin/area-memberships', U.editor, { personId: pid, area: 'learn' })).status).toBe(400);
    expect(await totalLinhas()).toBe(antes);
  });

  it('revogar SEM motivo → 400 e o vínculo segue vivo', async () => {
    const id = (await http('GET', `/api/admin/area-memberships?personId=${pid}`, U.editor)).body.data.memberships[0].id;
    expect((await http('POST', `/api/admin/area-memberships/${id}/revoke`, U.editor, {})).status).toBe(400);
    expect((await http('POST', `/api/admin/area-memberships/${id}/revoke`, U.editor, { reason: '   ' })).status).toBe(400);
    expect((await http('POST', `/api/admin/area-memberships/${id}/revoke`, U.editor)).status).toBe(400);
    expect(await vivos()).toBe(1);
  });

  it('revogar COM motivo → 200: grava ator e motivo, derruba a sessão, some de /v1/me/areas; repetir → 404', async () => {
    const id = (await http('GET', `/api/admin/area-memberships?personId=${pid}`, U.editor)).body.data.memberships[0].id;
    const sessoesAntes = revogacoesDeSessao;
    const r = await http('POST', `/api/admin/area-memberships/${id}/revoke`, U.editor, { reason: 'encerrado no teste' });
    expect(r.status).toBe(200);
    expect(r.body.data.revoked).toBe(1);

    const linha = (await admin.query(`SELECT revoked_by, reason, revoked_at IS NOT NULL AS revogado FROM iam.area_membership WHERE id = $1`, [id])).rows[0];
    expect(linha).toEqual({ revoked_by: U.editor, reason: 'encerrado no teste', revogado: true });
    expect(await vivos()).toBe(0);
    expect(revogacoesDeSessao).toBeGreaterThan(sessoesAntes);
    expect((await aluno()).body.areas).toEqual([]);

    expect((await http('POST', `/api/admin/area-memberships/${id}/revoke`, U.editor, { reason: 'de novo' })).status).toBe(404);
    expect((await http('POST', `/api/admin/area-memberships/${UUID_INEXISTENTE}/revoke`, U.editor, { reason: 'x' })).status).toBe(404);
    expect((await http('POST', `/api/admin/area-memberships/nao-e-uuid/revoke`, U.editor, { reason: 'x' })).status).toBe(400);
  });
});
