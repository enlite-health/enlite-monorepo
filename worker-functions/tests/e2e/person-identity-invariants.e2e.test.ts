/**
 * person-identity-invariants.e2e.test.ts — invariantes da PESSOA (spec acesso-do-cliente, F1, item 14; D647/D648).
 *
 * Banco real, sem mock. Fixtures sintéticas (`@enlite.test`, uid com sufixo único por execução); iam.person e
 * iam.person_login são append-only, então o teste não apaga (não colide: o sufixo é novo a cada execução).
 *
 * Um describe por invariante, rodável sozinho com `-t` (fase-1.md item 14): (a) family e worker, (b) staff e prestador,
 * (c) dois logins, (d) merge e undo, (e) revogação na árvore, (f) ficha real absorvida por sintética.
 * (a), (b), (c), (e) e (f) leem pelo `GET /v1/me/areas` REAL (cadeia mockAuth → AuthMiddleware → rota, porta efêmera); o
 * único dublê é o Firebase Admin (claims em memória, como em me-areas-route.e2e.test.ts). Merge é sempre pelo
 * `ExecuteAdminMergeUseCase` (caminho real), nunca por INSERT em iam.person.
 *
 * (d) merge pelo ExecuteAdminMergeUseCase (caminho do self-service/admin: executeSingleMerge) e undo pelo
 *     UndoMergeUseCase: o pid do login absorvido NUNCA muda; a pessoa absorvida passa a ver os vínculos da sobrevivente
 *     enquanto o merge vale e deixa de ver depois do undo. Revogação durante o merge some das duas e não volta no undo.
 */
import { randomBytes, randomUUID } from 'crypto';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { resolveCanonicalWorkerId } from '../../src/shared/database/resolveCanonicalWorkerId';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { ExecuteAdminMergeUseCase } from '../../src/application/dedup/ExecuteAdminMergeUseCase';
import { UndoMergeUseCase } from '../../src/application/dedup/UndoMergeUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
const ACTOR = `e2e-actor-${RUN}`;

let pool: Pool;
let app: AppDeFamilia;
const claims = new Map<string, Record<string, unknown>>();
const TENANT = '00000000-0000-0000-0000-000000000001';

/** 10 dígitos únicos por chamada (phone bruto é UNIQUE): fixture sintética, não é telefone de ninguém. */
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  const tail = (parseInt(RUN, 16) % 100000).toString().padStart(5, '0');
  return `549110${tail}${phoneSeq.toString().padStart(2, '0')}`.slice(0, 13);
}

async function seedWorker(label: string, uidOverride?: string): Promise<{ id: string; uid: string }> {
  const id = randomUUID();
  const uid = uidOverride ?? `e2e-d-${RUN}-${label}`;
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [id, uid, `${label}-${RUN}@enlite.test`, nextPhone()],
  );
  return { id, uid };
}

async function personOf(uid: string): Promise<string> {
  const r = await pool.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [uid]);
  return r.rows[0].p;
}

async function areasOf(personId: string): Promise<string[]> {
  const r = await pool.query(`SELECT area || ':' || role AS ar FROM iam.effective_area_memberships($1) ORDER BY 1`, [personId]);
  return r.rows.map((x) => x.ar);
}

async function mergedInto(personId: string): Promise<string | null> {
  const r = await pool.query(`SELECT merged_into_id FROM iam.person WHERE id = $1`, [personId]);
  return r.rows[0].merged_into_id;
}

async function loginPid(uid: string): Promise<string> {
  const r = await pool.query(`SELECT person_id FROM iam.person_login WHERE provider = 'firebase' AND uid = $1`, [uid]);
  return r.rows[0].person_id;
}

async function auditIdOf(survivorId: string, absorbedId: string): Promise<number> {
  const r = await pool.query(
    `SELECT id FROM worker_merge_audit WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid ORDER BY created_at DESC LIMIT 1`,
    [survivorId, absorbedId],
  );
  return Number(r.rows[0].id);
}

/** `GET /v1/me/areas` com o token mock do login (role 'admin' = staff pela ponte; 'worker' = prestador). */
async function chamar(uid: string, role: 'admin' | 'worker' = 'worker'): Promise<{ status: number; areas: string[]; refresh: boolean }> {
  const res = await fetch(`${app.url}/v1/me/areas`, { headers: { Authorization: tokenMock(uid, role) } });
  const body = JSON.parse((await res.text()) || '{}');
  const areas = ((body.areas ?? []) as Array<{ area: string; role: string }>).map((a) => `${a.area}:${a.role}`);
  return { status: res.status, areas, refresh: body.tokenRefreshRequired === true };
}

async function seedStaff(uid: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role, account_type, status, is_active, tenant_id)
     VALUES ($1, $2, 'admin', 'staff', 'ACTIVE', true, $3)`,
    [uid, `${uid}@enlite.test`, TENANT],
  );
}

async function grant(personId: string, area: string, role: string): Promise<void> {
  await pool.query(`SELECT iam.grant_area_membership($1::uuid, $2, $3, $4)`, [personId, area, role, ACTOR]);
}

const merge = (survivorId: string, absorbedId: string) =>
  new ExecuteAdminMergeUseCase(pool).execute({ survivorId, absorbedIds: [absorbedId] });

const envAnterior: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries({ USE_MOCK_AUTH: 'true', DATABASE_URL })) {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  }
  pool = new Pool({ connectionString: DATABASE_URL });
  (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
  // Dublê do Firebase Admin (só claims): o claim regravado é lido de volta DESTE mapa.
  jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
    getUser: async (u: string) => ({ uid: u, email: `${u}@enlite.test`, customClaims: claims.get(u) ?? {} }),
    setCustomUserClaims: async (u: string, c: Record<string, unknown>) => void claims.set(u, c),
    revokeRefreshTokens: async () => undefined,
  })) as never);
  app = await montarAppDeFamilia({
    montarRotas: ({ app: expressApp, auth }) => {
      const { createMeAreasRouter } = require('@modules/identity/interfaces/meAreasRoute');
      expressApp.use('/v1', createMeAreasRouter(auth.requireAuth(), pool));
    },
  });
}, 30000);

afterAll(async () => {
  jest.restoreAllMocks();
  await app?.fechar();
  await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`e2e-d-${RUN}-%`]);
  await pool.end();
  for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe('(a) family e worker', () => {
  it('prestador com care·family concedido tem os DOIS papéis; revogado o family, o worker continua e o claim é {"care":["worker"]}', async () => {
    const w = await seedWorker('a1');
    const pid = await personOf(w.uid);
    await grant(pid, 'care', 'family');

    const r1 = await chamar(w.uid);
    expect(r1.status).toBe(200);
    expect(r1.areas).toEqual(['care:family', 'care:worker']);
    expect(claims.get(w.uid)!.areas).toEqual({ care: ['family', 'worker'] });

    const n = await pool.query(`SELECT iam.revoke_area_membership($1::uuid, 'care', 'family', $2, 'e2e-a') AS n`, [pid, ACTOR]);
    expect(Number(n.rows[0].n)).toBe(1);

    const r2 = await chamar(w.uid);
    expect(r2.areas).toEqual(['care:worker']);
    expect(r2.refresh).toBe(true); // claim divergia (tinha family): regravado
    expect(claims.get(w.uid)!.areas).toEqual({ care: ['worker'] });
  });
});

describe('(b) staff e prestador', () => {
  it('uid staff com ficha em workers: backoffice·staff E care·worker, uma pessoa só', async () => {
    const w = await seedWorker('b1');
    await seedStaff(w.uid);

    const r = await chamar(w.uid, 'admin');
    expect(r.status).toBe(200);
    expect(r.areas).toEqual(['backoffice:staff', 'care:worker']);
    const n = await pool.query(`SELECT count(DISTINCT person_id) AS n FROM iam.person_login WHERE uid = $1`, [w.uid]);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it('V1: árvore {login staff, login prestador}: o prestador NÃO ganha backoffice, o staff ganha; os dois têm care·worker', async () => {
    const staff = await seedWorker('b2-staff');
    const prest = await seedWorker('b2-prest');
    await seedStaff(staff.uid);
    const pStaff = await personOf(staff.uid);
    await personOf(prest.uid);
    await merge(staff.id, prest.id); // prestador absorvido: a MESMA árvore, raiz = a pessoa do staff
    expect(await mergedInto(await loginPid(prest.uid))).toBe(pStaff);

    const rPrest = await chamar(prest.uid, 'worker');
    expect(rPrest.areas).toEqual(['care:worker']);
    expect(rPrest.areas).not.toContain('backoffice:staff');
    const rStaff = await chamar(staff.uid, 'admin');
    expect(rStaff.areas).toEqual(['backoffice:staff', 'care:worker']);
    // o claim também varia por login (V1/T107): o prestador não leva backoffice
    expect(claims.get(prest.uid)!.areas).toEqual({ care: ['worker'] });
    expect(claims.get(staff.uid)!.areas).toEqual({ backoffice: ['staff'], care: ['worker'] });
  });
});

describe('(c) dois logins', () => {
  it('uidA (absorvida) e uidB (raiz): a mesma lista de áreas nas duas chamadas e cada uma com o pid do PRÓPRIO login', async () => {
    const b = await seedWorker('c1-raiz');
    const a = await seedWorker('c1-abs');
    const pB = await personOf(b.uid);
    const pA = await personOf(a.uid);
    await merge(b.id, a.id);
    await grant(pB, 'learn', 'learner');

    const rA = await chamar(a.uid);
    const rB = await chamar(b.uid);
    expect(rA.areas).toEqual(['care:worker', 'learn:learner']);
    expect(rB.areas).toEqual(rA.areas);
    expect(pA).not.toBe(pB);
    // depois das DUAS chamadas, cada login segue com o pid da PRÓPRIA pessoa (a chamada de B não sobrescreve o de A)
    expect(claims.get(a.uid)!.pid).toBe(pA);
    expect(claims.get(b.uid)!.pid).toBe(pB);
    expect(claims.get(a.uid)!.areas).toEqual(claims.get(b.uid)!.areas);
    // convergiu: a 2ª chamada de A não vê divergência
    expect((await chamar(a.uid)).refresh).toBe(false);
  });
});

describe('(e) revogação na árvore', () => {
  it('learn·learner vivo na raiz e na absorvida: iam.revoke_area_membership revoga nas duas e nenhum login o vê', async () => {
    const b = await seedWorker('e1-raiz');
    const a = await seedWorker('e1-abs');
    const pB = await personOf(b.uid);
    const pA = await personOf(a.uid);
    await grant(pB, 'learn', 'learner'); // antes do merge: cada pessoa é raiz de si e recebe o seu vínculo
    await grant(pA, 'learn', 'learner');
    await merge(b.id, a.id);
    const vivos = () =>
      pool.query(`SELECT count(*)::int AS n FROM iam.area_membership WHERE person_id IN ($1::uuid, $2::uuid) AND area = 'learn' AND role = 'learner' AND revoked_at IS NULL`, [pB, pA]);
    expect((await vivos()).rows[0].n).toBe(2);
    expect((await chamar(a.uid)).areas).toContain('learn:learner');

    const rev = await pool.query(`SELECT iam.revoke_area_membership($1::uuid, 'learn', 'learner', $2, 'e2e-e') AS n`, [pB, ACTOR]);
    expect(Number(rev.rows[0].n)).toBe(2);
    expect((await vivos()).rows[0].n).toBe(0);
    expect((await chamar(a.uid)).areas).not.toContain('learn:learner');
    expect((await chamar(b.uid)).areas).not.toContain('learn:learner');
  });
});

describe('(f) ficha real absorvida por sintética', () => {
  it('perfil 1: o login real continua raiz de si mesma, care·worker derivado pela ficha absorvida, canônica = a sintética', async () => {
    const real = await seedWorker('f1-real');
    const sint = await seedWorker('f1-sint', `anacareimport_e2e_${RUN}`);
    const pReal = await personOf(real.uid);

    await merge(sint.id, real.id); // sintética sobrevive e absorve a ficha do uid real
    expect(await mergedInto(pReal)).toBeNull(); // iam.merge_person não une com sintética: nada a unir
    expect(await loginPid(real.uid)).toBe(pReal);
    const uids = await pool.query(`SELECT iam.person_login_uids($1::uuid) AS u`, [pReal]);
    expect(uids.rows.map((x) => x.u)).toEqual([real.uid]);
    const aud = await pool.query(`SELECT auth_uid, merged_into_id FROM workers WHERE id = $1::uuid`, [real.id]);
    expect(aud.rows[0].auth_uid).toBe(real.uid); // a ficha absorvida segue com o uid real
    expect(aud.rows[0].merged_into_id).toBe(sint.id);
    expect(await resolveCanonicalWorkerId(pool, real.id)).toBe(sint.id);

    const r = await chamar(real.uid);
    expect(r.status).toBe(200);
    expect(r.areas).toEqual(['care:worker']);
    expect(claims.get(real.uid)!.pid).toBe(pReal); // o login real ainda resolve na pessoa certa
  });

  it('perfil 2: ficha real absorvida por ficha real une as pessoas pelo ponteiro (a absorvida vê o vínculo da sobrevivente)', async () => {
    const surv = await seedWorker('f2-surv');
    const abs = await seedWorker('f2-abs');
    const pSurv = await personOf(surv.uid);
    const pAbs = await personOf(abs.uid);
    await grant(pSurv, 'learn', 'learner');

    await merge(surv.id, abs.id);
    expect(await mergedInto(pAbs)).toBe(pSurv);
    expect(await resolveCanonicalWorkerId(pool, abs.id)).toBe(surv.id);
    const r = await chamar(abs.uid);
    expect(r.areas).toEqual(['care:worker', 'learn:learner']);
    expect(claims.get(abs.uid)!.pid).toBe(pAbs);
  });
});

describe('(d) merge e undo', () => {
  it('merge une as pessoas por ponteiro sem mudar o pid do login; undo do mesmo auditId separa', async () => {
    const surv = await seedWorker('surv1');
    const abs = await seedWorker('abs1');
    const pSurv = await personOf(surv.uid);
    const pAbs = await personOf(abs.uid);
    expect(pSurv).not.toBe(pAbs);
    await pool.query(`SELECT iam.grant_area_membership($1, 'learn', 'learner', $2)`, [pSurv, ACTOR]);

    // antes do merge: a absorvida não vê nada
    expect(await areasOf(pAbs)).toEqual([]);

    await new ExecuteAdminMergeUseCase(pool).execute({ survivorId: surv.id, absorbedIds: [abs.id] });
    const auditId = await auditIdOf(surv.id, abs.id);

    expect(await mergedInto(pAbs)).toBe(pSurv);
    expect(await loginPid(abs.uid)).toBe(pAbs); // pid do login absorvido nunca muda
    expect(await areasOf(pAbs)).toEqual(['learn:learner']);
    const aud = await pool.query(`SELECT merged_by_worker_merge_audit_id AS a FROM iam.person WHERE id = $1`, [pAbs]);
    expect(Number(aud.rows[0].a)).toBe(auditId);

    const undo = await new UndoMergeUseCase(pool).execute(auditId);
    expect(undo.alreadyUndone).toBe(false);

    expect(await mergedInto(pAbs)).toBeNull();
    expect(await loginPid(abs.uid)).toBe(pAbs);
    expect(await areasOf(pAbs)).toEqual([]);
    expect(await areasOf(pSurv)).toEqual(['learn:learner']);
  });

  it('revogação durante o merge some das duas pessoas e continua sumida depois do undo; concessão fica com a sobrevivente', async () => {
    const surv = await seedWorker('surv2');
    const abs = await seedWorker('abs2');
    const pSurv = await personOf(surv.uid);
    const pAbs = await personOf(abs.uid);
    await pool.query(`SELECT iam.grant_area_membership($1, 'learn', 'learner', $2)`, [pSurv, ACTOR]);

    await new ExecuteAdminMergeUseCase(pool).execute({ survivorId: surv.id, absorbedIds: [abs.id] });
    const auditId = await auditIdOf(surv.id, abs.id);

    await pool.query(`SELECT iam.revoke_area_membership($1, 'learn', 'learner', $2, 'e2e-d')`, [pAbs, ACTOR]);
    await pool.query(`SELECT iam.grant_area_membership($1, 'learn', 'teacher', $2)`, [pSurv, ACTOR]);
    expect(await areasOf(pSurv)).toEqual(['learn:teacher']);
    expect(await areasOf(pAbs)).toEqual(['learn:teacher']);

    await new UndoMergeUseCase(pool).execute(auditId);

    expect(await areasOf(pAbs)).toEqual([]); // learner continua revogado; teacher é da sobrevivente
    expect(await areasOf(pSurv)).toEqual(['learn:teacher']);
  });

  it('undo repetido é no-op idempotente (alreadyUndone) e não mexe nas pessoas', async () => {
    const surv = await seedWorker('surv3');
    const abs = await seedWorker('abs3');
    const pSurv = await personOf(surv.uid);
    const pAbs = await personOf(abs.uid);

    await new ExecuteAdminMergeUseCase(pool).execute({ survivorId: surv.id, absorbedIds: [abs.id] });
    const auditId = await auditIdOf(surv.id, abs.id);
    expect(await mergedInto(pAbs)).toBe(pSurv);

    await new UndoMergeUseCase(pool).execute(auditId);
    const again = await new UndoMergeUseCase(pool).execute(auditId);
    expect(again.alreadyUndone).toBe(true);
    expect(await mergedInto(pAbs)).toBeNull();
  });
});
