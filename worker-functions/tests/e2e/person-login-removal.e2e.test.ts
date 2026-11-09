/**
 * person-login-removal.e2e.test.ts — conta apagada (spec acesso-do-cliente, F1, T132; DF-20, design §2.2).
 *
 * Os use cases REAIS (DeleteUser, DeleteUserByEmail, DeleteAdminUser) + o adapter REAL (PgLoginRemovalRepository)
 * contra o banco, conectado como membro de app_runtime (sem superuser). Firebase e repositório de `users` são dublês
 * (nunca o Firebase real; o prestador "puro" não tem linha em users). Fixtures sintéticas, sem PII.
 */
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';

const mockFirebaseDelete = jest.fn();
jest.mock('firebase-admin', () => ({
  auth: () => ({ deleteUser: (...a: unknown[]) => mockFirebaseDelete(...a) }),
}));
jest.mock('../../src/modules/identity/infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({
    isLastManager: jest.fn().mockResolvedValue(false),
    deleteByFirebaseUid: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { DeleteUserUseCase } from '../../src/modules/identity/application/DeleteUserUseCase';
import { DeleteUserByEmailUseCase } from '../../src/modules/identity/application/DeleteUserByEmailUseCase';
import { DeleteAdminUserUseCase } from '../../src/modules/identity/application/DeleteAdminUserUseCase';
import { PgLoginRemovalRepository } from '../../src/modules/identity/infrastructure/PgLoginRemovalRepository';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-login-rm-${RUN}-${n}`;
const ATOR = uid('ator');
const RT_USER = 'wf_login_removal_runtime';
const RT_PASSWORD = 'wf_login_removal_runtime_pw';

let admin: Pool;
let runtime: Pool;
let removal: PgLoginRemovalRepository;

const urlAs = (user: string, password: string) => {
  const u = new URL(DATABASE_URL);
  u.username = user;
  u.password = password;
  return u.toString();
};

/** Firebase dublê: `existe=false` imita "conta já ausente" — o service real devolve ok (NOT_FOUND = sucesso). */
const google = { deleteUser: jest.fn(), deleteUserByEmail: jest.fn() };
/** `users` dublê: o prestador puro não tem linha (userExists=false). */
const users = {
  existsByFirebaseUid: jest.fn(),
  deleteUserComplete: jest.fn(),
  findByEmail: jest.fn(),
};
const deleteUser = () => new DeleteUserUseCase(users as any, google as any, removal);

const pessoa = async (n: string): Promise<string> =>
  (await runtime.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [uid(n)])).rows[0].p;
const grantLearn = (p: string) =>
  runtime.query(`SELECT iam.grant_area_membership($1, 'learn', 'learner', $2)`, [p, ATOR]);
const login = async (n: string) =>
  (await admin.query(`SELECT removed_at, removed_reason FROM iam.person_login WHERE provider = 'firebase' AND uid = $1`, [uid(n)])).rows[0];
const memberships = async (p: string) =>
  (await admin.query(
    `SELECT revoked_at IS NOT NULL AS revogado, revoked_by, reason FROM iam.area_membership WHERE person_id = $1`, [p])).rows;

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RT_USER}') THEN
      CREATE ROLE ${RT_USER} LOGIN PASSWORD '${RT_PASSWORD}';
    END IF; END $$`);
  await admin.query(`GRANT app_runtime TO ${RT_USER}`);
  runtime = new Pool({ connectionString: urlAs(RT_USER, RT_PASSWORD) });
  removal = new PgLoginRemovalRepository(runtime);
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  google.deleteUser.mockReset().mockResolvedValue(Result.ok());
  google.deleteUserByEmail.mockReset().mockResolvedValue(Result.ok());
  users.existsByFirebaseUid.mockReset().mockResolvedValue(Result.ok(false));
  users.deleteUserComplete.mockReset().mockResolvedValue(Result.ok());
  users.findByEmail.mockReset();
  mockFirebaseDelete.mockReset().mockResolvedValue(undefined);
});

describe('DeleteUserUseCase → iam.remove_login', () => {
  it('apagar → o login ganha removed_at e removed_reason=account_deleted (prestador sem linha em users)', async () => {
    await pessoa('basico');
    expect(await login('basico')).toEqual({ removed_at: null, removed_reason: null });

    const r = await deleteUser().execute({ authUid: uid('basico') });

    expect(r.isSuccess).toBe(true);
    expect(users.deleteUserComplete).not.toHaveBeenCalled();
    const l = await login('basico');
    expect(l.removed_at).toBeInstanceOf(Date);
    expect(l.removed_reason).toBe('account_deleted');
  });

  it('última conta da árvore → vínculos vivos revogados com account_deleted (revoked_by = ator)', async () => {
    const p = await pessoa('ultima');
    await grantLearn(p);

    await deleteUser().execute({ authUid: uid('ultima') });

    expect(await memberships(p)).toEqual([{ revogado: true, revoked_by: uid('ultima'), reason: 'account_deleted' }]);
  });

  it('árvore com OUTRO login vivo → o login sai, os vínculos ficam', async () => {
    const a = await pessoa('arv-a');
    const b = await pessoa('arv-b');
    await admin.query(`UPDATE iam.person SET merged_into_id = $2, merged_at = now() WHERE id = $1`, [a, b]);
    await grantLearn(b);

    await deleteUser().execute({ authUid: uid('arv-a') });

    expect((await login('arv-a')).removed_reason).toBe('account_deleted');
    expect((await login('arv-b')).removed_at).toBeNull();
    expect(await memberships(b)).toEqual([{ revogado: false, revoked_by: null, reason: null }]);
  });

  it('conta JÁ ausente no Firebase (service devolve ok) → ainda assim marca o login', async () => {
    const p = await pessoa('ausente');
    await grantLearn(p);
    google.deleteUser.mockResolvedValue(Result.ok()); // NOT_FOUND vira ok no GoogleIdentityService

    const r = await deleteUser().execute({ authUid: uid('ausente') });

    expect(r.isSuccess).toBe(true);
    expect((await login('ausente')).removed_reason).toBe('account_deleted');
    expect((await memberships(p))[0].reason).toBe('account_deleted');
  });

  it('Firebase falhou → o login NÃO é marcado', async () => {
    await pessoa('fb-falha');
    google.deleteUser.mockResolvedValue(Result.fail('x'));

    const r = await deleteUser().execute({ authUid: uid('fb-falha') });

    expect(r.isFailure).toBe(true);
    expect((await login('fb-falha')).removed_at).toBeNull();
  });

  it('repetir é idempotente (login já removido não é erro)', async () => {
    await pessoa('repete');
    await deleteUser().execute({ authUid: uid('repete') });
    const r = await deleteUser().execute({ authUid: uid('repete') });
    expect(r.isSuccess).toBe(true);
  });
});

describe('os outros caminhos conta-apagada usam a mesma porta', () => {
  it('DeleteUserByEmailUseCase: marca o login e grava o ator informado', async () => {
    const p = await pessoa('email');
    await grantLearn(p);
    users.findByEmail.mockResolvedValue(Result.ok({ firebase_uid: uid('email'), email: 'x@example.test', role: 'worker' }));

    const r = await new DeleteUserByEmailUseCase(users as any, google as any, removal)
      .execute({ email: 'x@example.test', actorUid: ATOR });

    expect(r.isSuccess).toBe(true);
    expect((await login('email')).removed_reason).toBe('account_deleted');
    expect(await memberships(p)).toEqual([{ revogado: true, revoked_by: ATOR, reason: 'account_deleted' }]);
  });

  it('DeleteAdminUserUseCase: marca o login depois do Firebase', async () => {
    await pessoa('admin');

    const r = await new DeleteAdminUserUseCase(removal).execute(uid('admin'), ATOR);

    expect(r.isSuccess).toBe(true);
    expect(mockFirebaseDelete).toHaveBeenCalledWith(uid('admin'));
    expect((await login('admin')).removed_reason).toBe('account_deleted');
  });
});
