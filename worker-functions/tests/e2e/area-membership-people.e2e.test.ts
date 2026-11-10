/**
 * area-membership-people.e2e.test.ts — lista paginada de pessoas da aba "Vínculos de área" (change aba-vinculos-de-area, T1),
 * HTTP REAL + banco REAL, engine ABAC LIGADO em `admin.users`. A ÚNICA substituição é o Firebase Admin (dublê em memória).
 *
 * Provas que MORREM se desfizerem: (a) sem `area_membership:read` → 403; (b) a rota não loga e-mail nem termo de busca;
 * (c) conceder por `uid` cria a pessoa e o vínculo; (d) pessoa staff+prestador aparece UMA vez, `kind=staff`;
 * (e) paginação devolve `total` certo e o teto 100 vale.
 * `iam.*` é append-only: uids/e-mails levam sufixo aleatório por execução. Fixtures sintéticas (`@ejemplo.com`), sem PII.
 */
import { randomBytes } from 'crypto';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';
import { logger } from '@shared/logging';
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
const TAG = `pplx${RUN}`; // aparece em todo e-mail de staff/prestador desta execução → isola a busca de dados alheios
const U = {
  editor: `e2e-ppl-${RUN}-editor`,
  leitor: `e2e-ppl-${RUN}-leitor`,
  semGrupo: `e2e-ppl-${RUN}-sem-grupo`,
};
const GRUPOS = { editor: `Ppl Editor ${RUN}`, leitor: `Ppl Leitor ${RUN}` };
const mail = (s: string): string => `${s}.${TAG}@ejemplo.com`;
const STAFF_MULTI = [0, 1, 2, 3, 4].map((i) => `e2e-ppl-${RUN}-s${i}`);
const DUAL = `e2e-ppl-${RUN}-dual`; // staff E prestador com o MESMO login
const NOVA = `e2e-ppl-${RUN}-nova`; // login só-Firebase que nunca foi pessoa
const SO_PRESTADOR = `e2e-ppl-${RUN}-worker`;

describe('lista de pessoas da aba Vínculos de área — HTTP real, banco real, engine LIGADO', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let celulasCriadas: string[] = [];
  const firebaseProfiles = new Map<string, { displayName: string; email: string }>();
  const getUsersCalls: string[][] = [];
  let firebaseDown = false;
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
  const people = (qs: string, uid: string = U.leitor) => http('GET', `/api/admin/area-memberships/people?${qs}`, uid);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(admin, { uids: [U.editor, U.leitor, U.semGrupo, DUAL, ...STAFF_MULTI], grupos: Object.values(GRUPOS) });
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
      getUser: async (u: string) => ({ uid: u, email: firebaseProfiles.get(u)?.email ?? `${u}@ejemplo.com`, customClaims: {} }),
      setCustomUserClaims: async () => undefined,
      revokeRefreshTokens: async () => undefined,
      getUsers: async (ids: Array<{ uid: string }>) => {
        if (firebaseDown) throw new Error('boom');
        getUsersCalls.push(ids.map((i) => i.uid));
        return { users: ids.flatMap(({ uid }) => (firebaseProfiles.has(uid) ? [{ uid, ...firebaseProfiles.get(uid)! }] : [])), notFound: [] };
      },
      getUserByEmail: async (email: string) => {
        if (firebaseDown) throw new Error('boom');
        for (const [uid, p] of firebaseProfiles) if (p.email === email) return { uid, ...p };
        throw Object.assign(new Error('nope'), { code: 'auth/user-not-found' });
      },
    })) as never);

    const staff = async (uid: string, email: string, name: string) =>
      admin.query(
        `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id, account_type)
         VALUES ($1,$2,$3,'admin','ACTIVE',true,$4,'staff')`,
        [uid, email, name, TENANT_E2E],
      );
    for (const u of [U.editor, U.leitor, U.semGrupo]) await staff(u, mail(u), `Staff ${u}`);
    for (const u of STAFF_MULTI) await staff(u, mail(u), `Pessoa ${u}`);
    await staff(DUAL, mail(DUAL), 'Pessoa Dual');
    await admin.query(`INSERT INTO workers (auth_uid, email, country) VALUES ($1,$2,'AR')`, [DUAL, mail(`w-${DUAL}`)]);
    const { KMSEncryptionService } = await import('@shared/security/KMSEncryptionService');
    const { BlindIndexService } = await import('@shared/security/BlindIndexService');
    const kms = new KMSEncryptionService();
    const blind = new BlindIndexService();
    const bidx = blind.serializeForPg(await blind.generateNameTrigramBidx('Zenobia', `Quirogaxx${RUN}`));
    await admin.query(
      `INSERT INTO workers (auth_uid, email, country, first_name_encrypted, last_name_encrypted, name_trgm_bidx)
       VALUES ($1,$2,'AR',$3,$4,$5::bytea[])`,
      [SO_PRESTADOR, mail(SO_PRESTADOR), await kms.encrypt('Zenobia'), await kms.encrypt(`Quirogaxx${RUN}`), bidx],
    );
    firebaseProfiles.set(NOVA, { displayName: 'Cuenta Nueva Ejemplo', email: mail(NOVA) });

    celulasCriadas = await garantirCelulas(admin, ['area_membership:read', 'area_membership:write'], 'Administração');
    await grupoComCelulas(admin, { nome: GRUPOS.editor, uid: U.editor, celulas: [['area_membership', 'read'], ['area_membership', 'write']] });
    await grupoComCelulas(admin, { nome: GRUPOS.leitor, uid: U.leitor, celulas: [['area_membership', 'read']] });

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: ({ app: expressApp, auth, permissions }) => {
        const { createAdminAreaMembershipRoutes, AreaMembershipController } = require('@modules/identity');
        const pool = require('@shared/database/DatabaseConnection').DatabaseConnection.getInstance().getPool();
        expressApp.use('/api/admin', createAdminAreaMembershipRoutes(auth, permissions, AreaMembershipController.fromPool(pool)));
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.query(`DELETE FROM workers WHERE auth_uid = ANY($1)`, [[DUAL, SO_PRESTADOR]]);
    await limparIamFixtures(admin, { uids: [U.editor, U.leitor, U.semGrupo, DUAL, ...STAFF_MULTI], grupos: Object.values(GRUPOS) });
    await removerCelulasCriadas(admin, celulasCriadas);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('(a) 403 sem `area_membership:read`: lista e e-mail exato; com `read`, 200', async () => {
    expect((await people(`search=${TAG}%40`, U.semGrupo)).status).toBe(403);
    expect((await http('GET', `/api/admin/area-memberships/people/by-email?email=${encodeURIComponent(mail(NOVA))}`, U.semGrupo)).status).toBe(403);
    expect((await people(`search=${TAG}%40`, U.leitor)).status).toBe(200);
  });

  it('(d) staff que também é prestador (mesmo login) aparece UMA vez, kind=staff', async () => {
    const r = await people(`search=${encodeURIComponent(mail(DUAL))}`);
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(1);
    expect(r.body.data.items).toHaveLength(1);
    expect(r.body.data.items[0]).toMatchObject({ uid: DUAL, kind: 'staff', personId: null, memberships: [] });
    // busca pelo e-mail da ficha de prestador acha a MESMA pessoa (uma linha)
    const viaWorker = await people(`search=${encodeURIComponent(mail(`w-${DUAL}`))}`);
    expect(viaWorker.body.data.items.map((i: any) => [i.uid, i.kind])).toEqual([[DUAL, 'staff']]);
  });

  it('(e) paginação: `total` conta a população inteira; limit/offset fatiam; teto 100 vale', async () => {
    // fixtures com a TAG: 3 staff de acesso + 5 staff + 1 dual + 1 prestador = 10 (e-mail ILIKE)
    const all = await people(`search=${TAG}%40&limit=100`);
    expect(all.body.data.total).toBe(10);
    const p1 = await people(`search=${TAG}%40&limit=4&offset=0`);
    const p3 = await people(`search=${TAG}%40&limit=4&offset=8`);
    expect([p1.body.data.total, p1.body.data.items.length, p1.body.data.limit, p1.body.data.offset]).toEqual([10, 4, 4, 0]);
    expect([p3.body.data.total, p3.body.data.items.length]).toEqual([10, 2]);
    const paginas = await Promise.all([0, 4, 8].map(async (o) => (await people(`search=${TAG}%40&limit=4&offset=${o}`)).body.data.items));
    const uids = paginas.flat().map((i: any) => i.uid);
    expect(new Set(uids).size).toBe(10); // páginas disjuntas, sem repetir pessoa
    const teto = await people(`search=${TAG}%40&limit=500`);
    expect(teto.status).toBe(200);
    expect(teto.body.data.limit).toBe(100);
    expect((await people(`search=${TAG}%40&limit=0`)).status).toBe(200);
  });

  it('busca por NOME de prestador (blind index) acha só o prestador; termo curto → 400', async () => {
    const r = await people(`search=${encodeURIComponent(`Zenobia Quirogaxx${RUN}`)}`);
    expect(r.status).toBe(200);
    expect(r.body.data.items.map((i: any) => [i.uid, i.kind, i.displayName])).toEqual([[SO_PRESTADOR, 'worker', `Zenobia Quirogaxx${RUN}`]]);
    expect(r.body.data.total).toBe(1);
    expect((await people('search=ab')).status).toBe(400);
  });

  it('(c) conceder por `uid` cria a pessoa e o vínculo; a pessoa vira linha `account` com o perfil do Firebase', async () => {
    expect((await admin.query(`SELECT iam.resolve_person('firebase', $1) AS p`, [NOVA])).rows[0].p).toBeNull();
    const r = await http('POST', '/api/admin/area-memberships', U.editor, { uid: NOVA, area: 'learn', role: 'learner' });
    expect(r.status).toBe(201);
    const pid = (await admin.query(`SELECT iam.resolve_person('firebase', $1) AS p`, [NOVA])).rows[0].p as string;
    expect(pid).toEqual(expect.any(String));
    const linha = (await admin.query(`SELECT person_id, area, role, granted_by FROM iam.area_membership WHERE id = $1`, [r.body.data.membershipId])).rows[0];
    expect(linha).toEqual({ person_id: pid, area: 'learn', role: 'learner', granted_by: U.editor });

    getUsersCalls.length = 0;
    const lista = await people('type=account&withMembership=true&limit=100');
    const item = lista.body.data.items.find((i: any) => i.uid === NOVA);
    expect(item).toMatchObject({ personId: pid, kind: 'account', displayName: 'Cuenta Nueva Ejemplo', email: mail(NOVA) });
    expect(item.memberships).toEqual([{ id: r.body.data.membershipId, area: 'learn', role: 'learner' }]);
    expect(getUsersCalls.flat()).toContain(NOVA); // só linhas `account` da página vão ao Firebase
    // personId E uid juntos, ou nenhum → 400; sem `write` → 403
    expect((await http('POST', '/api/admin/area-memberships', U.editor, { personId: pid, uid: NOVA, area: 'learn', role: 'learner' })).status).toBe(400);
    expect((await http('POST', '/api/admin/area-memberships', U.leitor, { uid: NOVA, area: 'learn', role: 'learner' })).status).toBe(403);
    // withMembership=false não traz quem tem vínculo
    const sem = await people(`search=${TAG}%40&withMembership=false&limit=100`);
    expect(sem.body.data.items.every((i: any) => i.memberships.length === 0)).toBe(true);
  });

  it('e-mail exato: acha a pessoa (mesma forma de item), 404 sem usuário, 502 com Firebase fora (sem eco do e-mail)', async () => {
    const ok = await http('GET', `/api/admin/area-memberships/people/by-email?email=${encodeURIComponent(mail(NOVA))}`, U.leitor);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ uid: NOVA, kind: 'account', email: mail(NOVA) });
    expect(ok.body.data.memberships).toHaveLength(1);
    expect((await http('GET', `/api/admin/area-memberships/people/by-email?email=${encodeURIComponent(mail('ninguem'))}`, U.leitor)).status).toBe(404);
    expect((await http('GET', `/api/admin/area-memberships/people/by-email?email=nao-e-email`, U.leitor)).status).toBe(400);
    firebaseDown = true;
    const down = await http('GET', `/api/admin/area-memberships/people/by-email?email=${encodeURIComponent(mail(NOVA))}`, U.leitor);
    firebaseDown = false;
    expect(down.status).toBe(502);
    expect(JSON.stringify(down.body)).not.toContain(TAG);
  });

  it('(b) nenhum log carrega e-mail, nome nem termo de busca (sucesso e falha do Firebase)', async () => {
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((lvl) => jest.spyOn(logger, lvl));
    const spyConsole = [jest.spyOn(console, 'log'), jest.spyOn(console, 'error')];
    await people(`search=${encodeURIComponent(mail(DUAL))}`);
    await people(`search=${encodeURIComponent(`Zenobia Quirogaxx${RUN}`)}`);
    await http('GET', `/api/admin/area-memberships/people/by-email?email=${encodeURIComponent(mail(NOVA))}`, U.leitor);
    firebaseDown = true;
    await http('GET', `/api/admin/area-memberships/people/by-email?email=${encodeURIComponent(mail(NOVA))}`, U.leitor);
    await people('type=account&withMembership=true');
    firebaseDown = false;
    const logged = [...spies, ...spyConsole].flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c));
    expect(logged.some((l) => l.includes(TAG) || l.includes('Zenobia') || l.includes('Cuenta Nueva'))).toBe(false);
    expect(logged.some((l) => l.includes('falha'))).toBe(true); // o erro foi logado — só sem PII (prova que o espião enxerga)
    [...spies, ...spyConsole].forEach((s) => s.mockRestore());
  });
});
