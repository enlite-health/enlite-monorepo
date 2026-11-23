/**
 * PR-INF-34 (FR-88/C-43, DT-51) contra POSTGRES REAL: o SQL de `setPhoneIfNull` (só grava se NULL, atômico) e a
 * corrida `23505` em `idx_workers_phone_unique` virando PHONE_IN_USE. WorkerRepository e InitWorkerUseCase REAIS,
 * sem dublê de banco. Fixtures sintéticas `@e2e.local`, telefones derivados do carimbo (sem PII real).
 */
import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('telefone do worker no Postgres real (PR-INF-34)', () => {
  let pool: Pool;
  let repo: import('../../src/modules/worker/infrastructure/WorkerRepository').WorkerRepository;
  let InitWorkerUseCase: typeof import('../../src/modules/worker/application/InitWorkerUseCase').InitWorkerUseCase;
  const stamp = String(Date.now());
  const uid = (n: string) => `e2e-pi34-${n}-${stamp}`;
  const phone = (n: number) => `549${String(Number(stamp.slice(-7)) * 10 + n).padStart(10, '0').slice(-10)}`;
  const envAntes = process.env.DATABASE_URL;

  const ficha = async (n: string, tel: string | null): Promise<string> =>
    (await pool.query(
      "INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id",
      [uid(n), uid(n) + '@e2e.local', tel],
    )).rows[0].id;
  const phoneOf = async (id: string) => (await pool.query('SELECT phone FROM workers WHERE id = $1', [id])).rows[0].phone;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = new Pool({ connectionString: DATABASE_URL });
    const mod = await import('../../src/modules/worker/infrastructure/WorkerRepository');
    repo = new mod.WorkerRepository();
    ({ InitWorkerUseCase } = await import('../../src/modules/worker/application/InitWorkerUseCase'));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM workers WHERE auth_uid LIKE $1', [`e2e-pi34-%-${stamp}`]);
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.end();
    if (envAntes === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envAntes;
  });

  it('T-F3c-09 PG (a) ficha sem telefone: setPhoneIfNull grava e devolve a ficha', async () => {
    const id = await ficha('a', null);
    const saved = await repo.setPhoneIfNull(id, phone(1));
    expect(saved?.id).toBe(id);
    expect(saved?.phone).toBe(phone(1));
    expect(await phoneOf(id)).toBe(phone(1));
  });

  it('T-F3c-09 PG (b) ficha com telefone: 0 linhas (null) e o telefone não muda', async () => {
    const id = await ficha('b', phone(2));
    expect(await repo.setPhoneIfNull(id, phone(3))).toBeNull();
    expect(await phoneOf(id)).toBe(phone(2));
  });

  it('T-F3c-09 PG (c) corrida: telefone já gravado por outra ficha estoura 23505 e vira PHONE_IN_USE sem texto do Postgres', async () => {
    await ficha('c-dona', phone(4));
    const id = await ficha('c-corrida', null);
    // A leitura anterior não viu a dona (corrida): só o UPDATE real do Postgres decide.
    const cego = Object.create(repo);
    cego.findByPhoneCandidates = async () => Result.ok(null);
    const found = (await repo.findByAuthUid(uid('c-corrida'))).getValue()!;
    cego.findByAuthUid = async () => Result.ok(found);

    await expect(repo.setPhoneIfNull(id, phone(4))).rejects.toMatchObject({ code: '23505', constraint: 'idx_workers_phone_unique' });

    const out = await new InitWorkerUseCase(cego).execute({
      authUid: uid('c-corrida'), email: uid('c-corrida') + '@e2e.local', emailVerified: true, phone: `+${phone(4)}`, country: 'AR',
    });
    expect(out.isSuccess).toBe(true);
    expect(out.getValue()).toEqual({ status: 'phone_rejected', code: 'PHONE_IN_USE' });
    expect(JSON.stringify(out.getValue())).not.toMatch(/duplicate key|already exists/);
    expect(await phoneOf(id)).toBeNull();
  });
});
