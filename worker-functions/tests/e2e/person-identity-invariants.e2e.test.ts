/**
 * person-identity-invariants.e2e.test.ts — invariantes da PESSOA (spec acesso-do-cliente, F1, item 14; D647/D648).
 *
 * Banco real, sem mock. Fixtures sintéticas (`@enlite.test`, uid com sufixo único por execução); iam.person e
 * iam.person_login são append-only, então o teste não apaga (não colide: o sufixo é novo a cada execução).
 *
 * Aqui mora o describe "(d) merge e undo" (T130). Os demais (a, b, c, e, f) entram nas tasks T134/T135.
 *
 * (d) merge pelo ExecuteAdminMergeUseCase (caminho do self-service/admin: executeSingleMerge) e undo pelo
 *     UndoMergeUseCase: o pid do login absorvido NUNCA muda; a pessoa absorvida passa a ver os vínculos da sobrevivente
 *     enquanto o merge vale e deixa de ver depois do undo. Revogação durante o merge some das duas e não volta no undo.
 */
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { ExecuteAdminMergeUseCase } from '../../src/application/dedup/ExecuteAdminMergeUseCase';
import { UndoMergeUseCase } from '../../src/application/dedup/UndoMergeUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
const ACTOR = `e2e-actor-${RUN}`;

let pool: Pool;

/** 10 dígitos únicos por chamada (phone bruto é UNIQUE): fixture sintética, não é telefone de ninguém. */
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  const tail = (parseInt(RUN, 16) % 100000).toString().padStart(5, '0');
  return `549110${tail}${phoneSeq.toString().padStart(2, '0')}`.slice(0, 13);
}

async function seedWorker(label: string): Promise<{ id: string; uid: string }> {
  const id = randomUUID();
  const uid = `e2e-d-${RUN}-${label}`;
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

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
});

afterAll(async () => {
  await pool.end();
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
