/**
 * WorkerConsentRecord.repo.test.ts — Postgres REAL, executando como `enlite_app` (o papel de runtime, não o dono).
 * Aceite da política no init pelo app (spec 077): o dono do consentimento é o trio de `workers` (D514), o mesmo
 * que o cadastro web grava. MORRE se `recordConsentIfMissing` deixar de gravar o trio, sobrescrever o 1º aceite
 * ou tocar ficha absorvida.
 *
 *   DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand WorkerConsentRecord
 */
import { Pool } from 'pg';
import { recordConsentIfMissing } from '../../src/modules/worker/infrastructure/WorkerAuthRepository';

const URL_ = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5611/enlite_e2e';
const owner = new Pool({ connectionString: URL_ });
// Mesmo banco, papel de runtime: `options=-c role=enlite_app` faz SET ROLE na sessão.
const app = new Pool({ connectionString: URL_, options: '-c role=enlite_app' });

const T1 = new Date('2026-11-24T10:00:00Z');
const T2 = new Date('2026-11-25T10:00:00Z');
const ids: string[] = [];

async function ficha(mergedInto: string | null = null): Promise<string> {
  const uid = `consent-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await owner.query(
    `INSERT INTO workers (auth_uid, email, status, country, is_test, merged_into_id)
     VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', true, $3) RETURNING id`,
    [uid, `${uid}@enlite.test`, mergedInto],
  );
  ids.push(r.rows[0].id);
  return r.rows[0].id;
}
const trio = async (id: string) =>
  (await owner.query(`SELECT lgpd_consent_at a, terms_accepted_at b, privacy_accepted_at c FROM workers WHERE id=$1`, [id])).rows[0];

afterAll(async () => {
  if (ids.length) await owner.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ids]);
  await app.end();
  await owner.end();
});

describe('recordConsentIfMissing (enlite_app, banco real)', () => {
  it('roda como enlite_app', async () => {
    expect((await app.query('SELECT current_user u')).rows[0].u).toBe('enlite_app');
  });

  it('grava o trio com a data do aceite', async () => {
    const id = await ficha();
    expect(await recordConsentIfMissing(app, id, T1)).toBe(true);
    expect(await trio(id)).toEqual({ a: T1, b: T1, c: T1 });
  });

  it('o 1º aceite vale: segundo aceite não sobrescreve', async () => {
    const id = await ficha();
    await recordConsentIfMissing(app, id, T1);
    await recordConsentIfMissing(app, id, T2);
    expect(await trio(id)).toEqual({ a: T1, b: T1, c: T1 });
  });

  it('ficha absorvida (merged_into_id) não recebe aceite: devolve false', async () => {
    const survivor = await ficha();
    const absorbed = await ficha(survivor);
    expect(await recordConsentIfMissing(app, absorbed, T1)).toBe(false);
    expect(await trio(absorbed)).toEqual({ a: null, b: null, c: null });
  });
});
