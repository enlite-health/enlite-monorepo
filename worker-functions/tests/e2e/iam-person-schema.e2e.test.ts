/**
 * iam-person-schema.e2e.test.ts — contrato da PESSOA (spec acesso-do-cliente, F1, item 12; migration 580).
 *
 * Banco real, sem mock. Fixtures por uid/e-mail sintético `@enlite.test`, com sufixo único por execução
 * (iam.person e iam.person_login são append-only: o teste NÃO apaga, por isso não colide nem reaproveita).
 *
 * (a) forma: PK (provider, uid), funções SECURITY DEFINER com search_path fixo, sem EXECUTE para PUBLIC
 * (b) invariantes: mesmo (provider, uid) recusado (inclusive depois de removed_at), DELETE recusado,
 *     troca de person_id recusada, auto-merge e ciclo A→B→A recusados
 * (c) escrita só por função: como membro de app_runtime, INSERT/UPDATE/DELETE direto → permission denied (LISTA 19)
 * (d) funções: ensure/resolve/root/tree/login_uids, merge/unmerge com gate, remove_login, backfill
 */
import { randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-person-${RUN}-${n}`;
const RT_USER = 'wf_person_runtime';
const RT_PASSWORD = 'wf_person_runtime_pw';

let admin: Pool;
let runtime: Pool;

/** Mesma URL, trocando só o login: a API/teste conecta como membro de app_runtime, não como dono. */
function urlAs(user: string, password: string): string {
  const u = new URL(DATABASE_URL);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function personOf(u: string): Promise<string | null> {
  const r = await admin.query(`SELECT iam.resolve_person('firebase', $1) AS p`, [u]);
  return r.rows[0].p;
}

async function expectSqlError(p: Pool | PoolClient, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  let err: Error | undefined;
  try {
    await p.query(sql, params);
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();
  expect(err!.message).toMatch(pattern);
}

async function newPerson(): Promise<string> {
  const r = await admin.query(`INSERT INTO iam.person DEFAULT VALUES RETURNING id`);
  return r.rows[0].id;
}

async function worker(authUid: string, mergedInto?: string): Promise<string> {
  const r = await admin.query(
    `INSERT INTO workers (auth_uid, merged_into_id) VALUES ($1, $2) RETURNING id`,
    [authUid, mergedInto ?? null],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RT_USER}') THEN
      CREATE ROLE ${RT_USER} LOGIN PASSWORD '${RT_PASSWORD}';
    END IF; END $$`);
  await admin.query(`GRANT app_runtime TO ${RT_USER}`);
  runtime = new Pool({ connectionString: urlAs(RT_USER, RT_PASSWORD) });
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

describe('(a) forma do schema', () => {
  it('iam.person e iam.person_login existem e a PK do login é (provider, uid)', async () => {
    const r = await admin.query(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = 'iam.person_login'::regclass AND i.indisprimary`,
    );
    expect(r.rows[0].cols).toEqual(['provider', 'uid']);
    const t = await admin.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='iam' AND tablename IN ('person','person_login')`);
    expect(t.rows[0].n).toBe(2);
  });

  it('as 8 funções públicas são SECURITY DEFINER com search_path fixo e sem EXECUTE para PUBLIC', async () => {
    const nomes = ['ensure_person', 'resolve_person', 'person_root', 'person_tree',
      'person_login_uids', 'merge_person', 'unmerge_person', 'remove_login'];
    const r = await admin.query(
      `SELECT p.proname, p.prosecdef, p.proconfig::text AS cfg,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt_exec,
              has_function_privilege('app_system', p.oid, 'EXECUTE') AS sys_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'iam' AND p.proname = ANY($1) ORDER BY p.proname`,
      [nomes],
    );
    expect(r.rows.map((x) => x.proname).sort()).toEqual([...nomes].sort());
    for (const f of r.rows) {
      expect(f.prosecdef).toBe(true);
      expect(f.cfg).toContain('search_path=pg_catalog, iam, public');
      expect(f.public_exec).toBe(false);
      expect(f.rt_exec).toBe(true);
      expect(f.sys_exec).toBe(true);
    }
  });
});

describe('(b) invariantes das tabelas (como dono)', () => {
  it('o mesmo (provider, uid) para OUTRA pessoa é recusado', async () => {
    const u = uid('dup');
    await admin.query(`SELECT iam.ensure_person('firebase', $1)`, [u]);
    const outra = await newPerson();
    await expectSqlError(admin,
      `INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('firebase', $1, $2)`,
      [u, outra], /duplicate key|person_login_pkey/);
  });

  it('o mesmo (provider, uid) é recusado inclusive DEPOIS de removed_at', async () => {
    const u = uid('dup-removido');
    await admin.query(`SELECT iam.ensure_person('firebase', $1)`, [u]);
    await admin.query(`SELECT iam.remove_login('firebase', $1, $2)`, [u, uid('ator')]);
    const outra = await newPerson();
    await expectSqlError(admin,
      `INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('firebase', $1, $2)`,
      [u, outra], /duplicate key|person_login_pkey/);
  });

  it('DELETE em iam.person e em iam.person_login é recusado (até para o dono)', async () => {
    const u = uid('del');
    const p = await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u]);
    await expectSqlError(admin, `DELETE FROM iam.person_login WHERE uid = $1`, [u], /append-only: DELETE recusado/);
    await expectSqlError(admin, `DELETE FROM iam.person WHERE id = $1`, [p.rows[0].p], /append-only: DELETE recusado/);
  });

  it('troca de person_id de um login é recusada', async () => {
    const u = uid('troca');
    await admin.query(`SELECT iam.ensure_person('firebase', $1)`, [u]);
    const outra = await newPerson();
    await expectSqlError(admin,
      `UPDATE iam.person_login SET person_id = $2 WHERE uid = $1`, [u, outra], /person_id é imutável/);
  });

  it('provider fora de firebase, uid vazio e removed_at sem motivo são recusados', async () => {
    const p = await newPerson();
    await expectSqlError(admin,
      `INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('auth0', $1, $2)`, [uid('prov'), p], /check constraint/);
    await expectSqlError(admin,
      `INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('firebase', '', $1)`, [p], /check constraint/);
    await expectSqlError(admin,
      `INSERT INTO iam.person_login (provider, uid, person_id, removed_at) VALUES ('firebase', $1, $2, now())`,
      [uid('semmotivo'), p], /person_login_removal_complete/);
  });

  it('auto-merge e ciclo A→B→A são recusados; B→A só passa depois de desfazer', async () => {
    const a = await newPerson();
    const b = await newPerson();
    await expectSqlError(admin,
      `UPDATE iam.person SET merged_into_id = id, merged_at = now() WHERE id = $1`, [a], /person_not_self_merged/);
    await admin.query(`UPDATE iam.person SET merged_into_id = $2, merged_at = now() WHERE id = $1`, [a, b]);
    await expectSqlError(admin,
      `UPDATE iam.person SET merged_into_id = $2, merged_at = now() WHERE id = $1`, [b, a], /ciclo na cadeia de merge/);
  });

  it('pessoa nasce não absorvida e merged_* sem merged_into_id é recusado', async () => {
    const b = await newPerson();
    await expectSqlError(admin,
      `INSERT INTO iam.person (merged_into_id, merged_at) VALUES ($1, now())`, [b], /nasce não absorvida/);
    await expectSqlError(admin,
      `UPDATE iam.person SET merged_by_worker_merge_audit_id = 1 WHERE id = $1`, [b], /person_merge_ref_needs_merge|person_merge_complete/);
  });
});

describe('(c) escrita só por função: como membro de app_runtime (LISTA 19)', () => {
  it('o login do teste é membro de app_runtime e NÃO é superuser', async () => {
    const r = await runtime.query(
      `SELECT pg_has_role(current_user, 'app_runtime', 'MEMBER') AS membro,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`);
    expect(r.rows[0]).toEqual({ membro: true, super: false });
  });

  it('INSERT direto em iam.person e em iam.person_login → permission denied', async () => {
    await expectSqlError(runtime, `INSERT INTO iam.person DEFAULT VALUES`, [], /permission denied for table person/);
    const p = await newPerson();
    await expectSqlError(runtime,
      `INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('firebase', $1, $2)`,
      [uid('rt-direto'), p], /permission denied for table person_login/);
  });

  it('UPDATE e DELETE direto nas duas tabelas → permission denied', async () => {
    const u = uid('rt-upd');
    await admin.query(`SELECT iam.ensure_person('firebase', $1)`, [u]);
    await expectSqlError(runtime, `UPDATE iam.person_login SET removed_at = now(), removed_reason = 'account_deleted' WHERE uid = $1`, [u], /permission denied for table person_login/);
    await expectSqlError(runtime, `DELETE FROM iam.person_login WHERE uid = $1`, [u], /permission denied for table person_login/);
    await expectSqlError(runtime, `UPDATE iam.person SET merged_at = now()`, [], /permission denied for table person/);
    await expectSqlError(runtime, `DELETE FROM iam.person`, [], /permission denied for table person/);
  });

  it('SELECT iam.ensure_person grava 1 pessoa + 1 login e a função de leitura a devolve', async () => {
    const u = uid('rt-fn');
    const antes = await admin.query(`SELECT count(*)::int AS n FROM iam.person_login WHERE uid = $1`, [u]);
    expect(antes.rows[0].n).toBe(0);
    const e = await runtime.query(`SELECT iam.ensure_person('firebase', $1) AS pid`, [u]);
    const depois = await admin.query(`SELECT person_id FROM iam.person_login WHERE uid = $1`, [u]);
    expect(depois.rowCount).toBe(1);
    expect(depois.rows[0].person_id).toBe(e.rows[0].pid);
    const r = await runtime.query(`SELECT iam.resolve_person('firebase', $1) AS pid`, [u]);
    expect(r.rows[0].pid).toBe(e.rows[0].pid);
  });
});

describe('(d) funções', () => {
  it('ensure_person é idempotente (mesma pid, nenhuma linha nova)', async () => {
    const u = uid('idem');
    const a = await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u]);
    const b = await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u]);
    expect(b.rows[0].p).toBe(a.rows[0].p);
    const n = await admin.query(`SELECT count(*)::int AS n FROM iam.person_login WHERE uid = $1`, [u]);
    expect(n.rows[0].n).toBe(1);
  });

  it('chamadas concorrentes de ensure_person para o mesmo uid criam UMA pessoa', async () => {
    const u = uid('conc');
    const r = await Promise.all(Array.from({ length: 6 }, () => runtime.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u])));
    expect(new Set(r.map((x) => x.rows[0].p)).size).toBe(1);
    const n = await admin.query(`SELECT count(*)::int AS n FROM iam.person_login WHERE uid = $1`, [u]);
    expect(n.rows[0].n).toBe(1);
  });

  it('remove_login: resolve → NULL, ensure_person → NULL (conta apagada não ressuscita), linha fica', async () => {
    const u = uid('rm');
    await admin.query(`SELECT iam.ensure_person('firebase', $1)`, [u]);
    await runtime.query(`SELECT iam.remove_login('firebase', $1, $2)`, [u, uid('ator')]);
    expect(await personOf(u)).toBeNull();
    const e = await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u]);
    expect(e.rows[0].p).toBeNull();
    const l = await admin.query(`SELECT removed_reason FROM iam.person_login WHERE uid = $1`, [u]);
    expect(l.rows[0].removed_reason).toBe('account_deleted');
    await expectSqlError(admin, `SELECT iam.remove_login('firebase', $1, '')`, [u], /exige o ator/);
  });

  it('merge_person: ponteiro, raiz, árvore, uids vivos; o login absorvido mantém o próprio pid', async () => {
    const ua = uid('m-a');
    const ub = uid('m-b');
    const wb = await worker(ub);
    await worker(ua, wb); // a ficha de A aponta para a de B (o que o gancho encontra antes do COMMIT)
    const pa = (await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [ua])).rows[0].p;
    const pb = (await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [ub])).rows[0].p;
    await runtime.query(`SELECT iam.merge_person($1, $2, NULL)`, [ua, ub]);
    expect(await personOf(ua)).toBe(pa); // pid do login: imutável
    const root = await admin.query(`SELECT iam.person_root($1) AS r`, [pa]);
    expect(root.rows[0].r).toBe(pb);
    const tree = await admin.query(`SELECT iam.person_tree($1) AS t`, [pa]);
    expect(tree.rows.map((x) => x.t).sort()).toEqual([pa, pb].sort());
    const uids = await admin.query(`SELECT iam.person_login_uids($1) AS u`, [pb]);
    expect(uids.rows.map((x) => x.u).sort()).toEqual([ua, ub].sort());
    const via = await admin.query(`SELECT iam.person_login_uids($1) AS u`, [pa]);
    expect(via.rows.map((x) => x.u).sort()).toEqual([ua, ub].sort());
    // segundo merge do mesmo par: raízes iguais → nada
    await admin.query(`SELECT iam.merge_person($1, $2, NULL)`, [ua, ub]);
    const n = await admin.query(`SELECT count(*)::int AS n FROM iam.person WHERE id = ANY($1) AND merged_into_id IS NOT NULL`, [[pa, pb]]);
    expect(n.rows[0].n).toBe(1);
  });

  it('merge_person recusa quando a ficha absorvida NÃO aponta para a sobrevivente (gate A3)', async () => {
    const ua = uid('g-a');
    const ub = uid('g-b');
    await worker(ub);
    await worker(ua); // sem merged_into_id
    await expectSqlError(runtime, `SELECT iam.merge_person($1, $2, NULL)`, [ua, ub], /não aponta para a ficha do uid sobrevivente/);
  });

  it('merge_person com uid sintético ou vazio não faz nada', async () => {
    const real = uid('s-real');
    await admin.query(`SELECT iam.merge_person('talentum_abc', $1, NULL)`, [real]);
    await admin.query(`SELECT iam.merge_person($1, '', NULL)`, [real]);
    expect(await personOf(real)).toBeNull(); // nem criou pessoa para o real
  });

  it('unmerge_person solta só as pessoas daquele audit; audit inexistente é recusado', async () => {
    const ua = uid('u-a');
    const ub = uid('u-b');
    const wb = await worker(ub);
    const wa = await worker(ua, wb);
    const audit = await admin.query(
      `INSERT INTO worker_merge_audit (survivor_id, absorbed_id, phone_normalized, category)
       VALUES ($1, $2, '0', 'firebase') RETURNING id`, [wb, wa]);
    const auditId = audit.rows[0].id;
    const pa = (await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [ua])).rows[0].p;
    await admin.query(`SELECT iam.merge_person($1, $2, $3)`, [ua, ub, auditId]);
    const m = await admin.query(`SELECT merged_by_worker_merge_audit_id AS a FROM iam.person WHERE id = $1`, [pa]);
    expect(Number(m.rows[0].a)).toBe(Number(auditId));
    await runtime.query(`SELECT iam.unmerge_person($1)`, [auditId]);
    const d = await admin.query(`SELECT merged_into_id, merged_at, merged_by_worker_merge_audit_id FROM iam.person WHERE id = $1`, [pa]);
    expect(d.rows[0]).toEqual({ merged_into_id: null, merged_at: null, merged_by_worker_merge_audit_id: null });
    await expectSqlError(runtime, `SELECT iam.unmerge_person(-1)`, [], /worker_merge_audit inexistente/);
  });

  it('backfill: um login por uid real distinto (users ∩ workers = 1), sintético fora, aresta de merge com e sem audit', async () => {
    const only = uid('b-user');
    const both = uid('b-both');
    const wSurv = uid('b-surv');
    const wAbs = uid('b-abs');
    const wAbs2 = uid('b-abs2'); // aresta SEM audit
    const synth = `talentum_${RUN}`;
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, account_type) VALUES
         ($1, $2, 'recruiter', 'staff'), ($3, $4, 'recruiter', 'staff')`,
      [only, `only-${RUN}@enlite.test`, both, `both-${RUN}@enlite.test`]);
    await worker(both);
    await worker(synth);
    const survId = await worker(wSurv);
    const absId = await worker(wAbs, survId);
    await worker(wAbs2, survId);
    const audit = await admin.query(
      `INSERT INTO worker_merge_audit (survivor_id, absorbed_id, phone_normalized, category)
       VALUES ($1, $2, '0', 'firebase') RETURNING id`, [survId, absId]);

    await admin.query(`SELECT iam._backfill_person()`);
    await admin.query(`SELECT iam._backfill_person()`); // idempotente

    const l = await admin.query(
      `SELECT uid, count(*)::int AS n FROM iam.person_login WHERE uid = ANY($1) GROUP BY uid`,
      [[only, both, wSurv, wAbs, wAbs2, synth]]);
    const porUid = Object.fromEntries(l.rows.map((r) => [r.uid, r.n]));
    expect(porUid).toEqual({ [only]: 1, [both]: 1, [wSurv]: 1, [wAbs]: 1, [wAbs2]: 1 }); // sintético não entra
    const pSurv = await personOf(wSurv);
    const abs = await admin.query(
      `SELECT p.merged_into_id, p.merged_by_worker_merge_audit_id AS a
         FROM iam.person p JOIN iam.person_login l ON l.person_id = p.id WHERE l.uid = $1`, [wAbs]);
    expect(abs.rows[0].merged_into_id).toBe(pSurv);
    expect(Number(abs.rows[0].a)).toBe(Number(audit.rows[0].id));
    const abs2 = await admin.query(
      `SELECT p.merged_into_id, p.merged_by_worker_merge_audit_id AS a
         FROM iam.person p JOIN iam.person_login l ON l.person_id = p.id WHERE l.uid = $1`, [wAbs2]);
    expect(abs2.rows[0].merged_into_id).toBe(pSurv);
    expect(abs2.rows[0].a).toBeNull(); // sem audit → sem desfazer
  });
});
