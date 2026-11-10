/**
 * area-membership-schema.e2e.test.ts — contrato do VÍNCULO de área (spec acesso-do-cliente, F1, T103; migration 581).
 *
 * Banco real, sem mock. Fixtures sintéticas (uid `e2e-area-<run>-*`); iam.person e iam.area_membership são
 * append-only: o teste NÃO apaga, cada caso usa a própria pessoa (sufixo único por execução).
 *
 * (a) forma: FK para iam.person, índice vivo (person_id, area, role), funções SECURITY DEFINER sem EXECUTE para PUBLIC
 * (b) pares válidos = Area.ts = CHECK (clinic, backoffice·staff, care·worker e papéis soltos recusados)
 * (c) CHECK de revogação completa, inclusive reason NULL (LISTA 20)
 * (d) append-only e unicidade do vínculo vivo
 * (e) remove_login revoga os vínculos quando a árvore fica sem login vivo (DF-20)
 */
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { STORED_AREA_ROLE_PAIRS, isStoredAreaRole } from '../../src/modules/identity/domain/Area';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-area-${RUN}-${n}`;
const ATOR = uid('ator');

let admin: Pool;

async function newPerson(): Promise<string> {
  const r = await admin.query(`INSERT INTO iam.person DEFAULT VALUES RETURNING id`);
  return r.rows[0].id;
}

async function insertRow(person: string, area: string, role: string, extra = ''): Promise<void> {
  await admin.query(
    `INSERT INTO iam.area_membership (person_id, area, role, granted_by) VALUES ($1, $2, $3, $4) ${extra}`,
    [person, area, role, ATOR],
  );
}

async function expectSqlError(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  let err: Error | undefined;
  try {
    await admin.query(sql, params);
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();
  expect(err!.message).toMatch(pattern);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await admin.end();
});

describe('(a) forma do schema', () => {
  it('iam.area_membership existe, person_id tem FK para iam.person e há índice vivo único (person_id, area, role)', async () => {
    const t = await admin.query(`SELECT to_regclass('iam.area_membership')::text AS t`);
    expect(t.rows[0].t).toBe('iam.area_membership');
    const fk = await admin.query(
      `SELECT confrelid::regclass::text AS ref FROM pg_constraint
        WHERE conrelid = 'iam.area_membership'::regclass AND contype = 'f'`,
    );
    expect(fk.rows.map((r) => r.ref)).toEqual(['iam.person']);
    const ix = await admin.query(
      `SELECT i.indisunique AS uniq, pg_get_expr(i.indpred, i.indrelid) AS pred,
              array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid AND c.relname = 'uq_area_membership_live'
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        GROUP BY i.indisunique, i.indpred, i.indrelid`,
    );
    expect(ix.rows).toHaveLength(1);
    expect(ix.rows[0].uniq).toBe(true);
    expect(ix.rows[0].cols).toEqual(['person_id', 'area', 'role']);
    expect(ix.rows[0].pred).toMatch(/revoked_at IS NULL/);
  });

  it('as 3 funções públicas são SECURITY DEFINER com search_path fixo e sem EXECUTE para PUBLIC', async () => {
    const nomes = ['grant_area_membership', 'revoke_area_membership', 'effective_area_memberships'];
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

describe('(b) pares válidos = Area.ts = CHECK area_membership_area_role', () => {
  it('Area.ts lista exatamente 4 pares', () => {
    expect(STORED_AREA_ROLE_PAIRS.map(([a, r]) => `${a}:${r}`).sort()).toEqual(
      ['care:family', 'learn:learner', 'learn:manager', 'learn:teacher'],
    );
  });

  it.each([
    ['care', 'family'], ['learn', 'learner'], ['learn', 'teacher'], ['learn', 'manager'],
  ])('par %s·%s é aceito pelo banco', async (area, role) => {
    expect(isStoredAreaRole(area, role)).toBe(true);
    await expect(insertRow(await newPerson(), area, role)).resolves.toBeUndefined();
  });

  it.each([
    ['clinic', 'owner'], ['clinic', 'family'], ['backoffice', 'staff'], ['care', 'worker'],
    ['care', 'learner'], ['learn', 'family'], ['learn', 'owner'], ['unknown', 'family'], ['', ''],
  ])('par %s·%s é recusado pelo banco e por Area.ts', async (area, role) => {
    expect(isStoredAreaRole(area, role)).toBe(false);
    await expectSqlError(
      `INSERT INTO iam.area_membership (person_id, area, role, granted_by) VALUES ($1, $2, $3, $4)`,
      [await newPerson(), area, role, ATOR], /area_membership_area_role/,
    );
  });

  it('person_id inexistente é recusado pela FK e granted_by vazio pelo CHECK', async () => {
    await expectSqlError(
      `INSERT INTO iam.area_membership (person_id, area, role, granted_by)
       VALUES (gen_random_uuid(), 'learn', 'learner', $1)`,
      [ATOR], /foreign key|area_membership_person_id_fkey/,
    );
    await expectSqlError(
      `INSERT INTO iam.area_membership (person_id, area, role, granted_by) VALUES ($1, 'learn', 'learner', '  ')`,
      [await newPerson()], /check constraint/,
    );
  });
});

describe('(c) CHECK de revogação completa (LISTA 20)', () => {
  const ins = `INSERT INTO iam.area_membership (person_id, area, role, granted_by, revoked_at, revoked_by, reason)
               VALUES ($1, 'learn', 'learner', $2, $3, $4, $5)`;

  it('vínculo revogado completo (revoked_at + revoked_by + reason) é aceito', async () => {
    await expect(admin.query(ins, [await newPerson(), ATOR, new Date(), ATOR, 'saiu'])).resolves.toBeDefined();
  });

  it('revoked_at sem revoked_by e sem reason é recusado', async () => {
    await expectSqlError(ins, [await newPerson(), ATOR, new Date(), null, null], /area_membership_revocation_complete/);
  });

  it('revoked_at + revoked_by com reason NULL é recusado (o furo do esboço)', async () => {
    await expectSqlError(ins, [await newPerson(), ATOR, new Date(), ATOR, null], /area_membership_revocation_complete/);
  });

  it('reason só com espaços é recusado', async () => {
    await expectSqlError(ins, [await newPerson(), ATOR, new Date(), ATOR, '   '], /area_membership_revocation_complete/);
  });

  it('reason ou revoked_by sem revoked_at é recusado', async () => {
    await expectSqlError(ins, [await newPerson(), ATOR, null, ATOR, 'x'], /area_membership_revocation_complete/);
    await expectSqlError(ins, [await newPerson(), ATOR, null, null, 'x'], /area_membership_revocation_complete/);
  });
});

describe('(d) append-only e unicidade do vínculo vivo', () => {
  it('o segundo vínculo vivo igual é recusado; revogado, um novo pode nascer; outro papel convive', async () => {
    const p = await newPerson();
    await insertRow(p, 'learn', 'learner');
    await expectSqlError(
      `INSERT INTO iam.area_membership (person_id, area, role, granted_by) VALUES ($1, 'learn', 'learner', $2)`,
      [p, ATOR], /uq_area_membership_live|duplicate key/,
    );
    await insertRow(p, 'learn', 'teacher');
    await admin.query(
      `UPDATE iam.area_membership SET revoked_at = now(), revoked_by = $2, reason = 'teste'
        WHERE person_id = $1 AND role = 'learner'`, [p, ATOR]);
    await expect(insertRow(p, 'learn', 'learner')).resolves.toBeUndefined();
  });

  it('DELETE é recusado (até para o dono) e UPDATE só preenche revoked_*, uma vez', async () => {
    const p = await newPerson();
    await insertRow(p, 'care', 'family');
    await expectSqlError(`DELETE FROM iam.area_membership WHERE person_id = $1`, [p], /append-only: DELETE recusado/);
    await expectSqlError(
      `UPDATE iam.area_membership SET role = 'family', area = 'care', granted_by = 'outro' WHERE person_id = $1`,
      [p], /só revoked_by, revoked_at e reason mudam/);
    await admin.query(
      `UPDATE iam.area_membership SET revoked_at = now(), revoked_by = $2, reason = 'a' WHERE person_id = $1`, [p, ATOR]);
    await expectSqlError(
      `UPDATE iam.area_membership SET reason = 'b' WHERE person_id = $1`, [p], /já revogado é imutável/);
  });
});

describe('(e) remove_login revoga vínculos quando a árvore fica sem login vivo (DF-20)', () => {
  async function pessoaComLogin(u: string): Promise<string> {
    const r = await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u]);
    return r.rows[0].p;
  }
  const vivos = async (p: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM iam.effective_area_memberships($1)`, [p])).rows[0].n;

  it('último login removido → vínculo revogado com account_deleted e revoked_by = ator', async () => {
    const u = uid('unico');
    const p = await pessoaComLogin(u);
    await admin.query(`SELECT iam.grant_area_membership($1, 'learn', 'learner', $2)`, [p, ATOR]);
    expect(await vivos(p)).toBe(1);
    await admin.query(`SELECT iam.remove_login('firebase', $1, $2)`, [u, uid('quem-apagou')]);
    expect(await vivos(p)).toBe(0);
    const r = await admin.query(`SELECT reason, revoked_by FROM iam.area_membership WHERE person_id = $1`, [p]);
    expect(r.rows).toEqual([{ reason: 'account_deleted', revoked_by: uid('quem-apagou') }]);
  });

  it('ainda há outro login vivo na árvore → vínculo continua vivo', async () => {
    const u1 = uid('dois-a');
    const u2 = uid('dois-b');
    const p = await pessoaComLogin(u1);
    await admin.query(`INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('firebase', $1, $2)`, [u2, p]);
    await admin.query(`SELECT iam.grant_area_membership($1, 'care', 'family', $2)`, [p, ATOR]);
    await admin.query(`SELECT iam.remove_login('firebase', $1, $2)`, [u1, ATOR]);
    expect(await vivos(p)).toBe(1);
  });
});
