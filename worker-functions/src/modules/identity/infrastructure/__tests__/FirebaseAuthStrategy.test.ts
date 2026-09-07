/**
 * FirebaseAuthStrategy — de onde sai o TIPO da conta do principal (D294):
 *   claim `account_type` → coluna `users.account_type` (só se falta claim) → ponte pelo papel.
 * Claim desconhecido é ignorado (fail-closed), e sem nada o principal fica sem tipo —
 * quem decide o 403 é a fronteira (`isStaffAccount`), nunca este arquivo.
 */
const mockVerifyIdToken = jest.fn();
jest.mock('firebase-admin', () => ({
  __esModule: true,
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Pool } from 'pg';
import { FirebaseAuthStrategy } from '../FirebaseAuthStrategy';
import { CredentialType, type Credentials, type RequestMetadata } from '../../domain/Auth';

const credentials: Credentials = { type: CredentialType.GOOGLE_ID_TOKEN, token: 'tok', scopes: [] };
const metadata: RequestMetadata = { ipAddress: '127.0.0.1', requestId: 'r', timestamp: new Date(), path: '/', method: 'GET' };

function dbWith(row: { role: string | null; account_type: string | null } | null): { pool: Pool; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue({ rows: row ? [row] : [] });
  return { pool: { query } as unknown as Pool, query };
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('FirebaseAuthStrategy — produção (verifyIdToken)', () => {
  const emulatorAnterior = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  beforeEach(() => {
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    mockVerifyIdToken.mockReset();
  });
  afterAll(() => {
    if (emulatorAnterior !== undefined) process.env.FIREBASE_AUTH_EMULATOR_HOST = emulatorAnterior;
  });

  it('desligada → null sem verificar nada', async () => {
    expect(await new FirebaseAuthStrategy(false).authenticate(credentials, metadata)).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('claims completos (role + account_type + country): NÃO consulta o banco', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@enlite.health', role: 'recruiter', account_type: 'staff', country: 'AR' });
    const { pool, query } = dbWith(null);
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(ctx?.principal).toMatchObject({ id: 'u1', roles: ['recruiter'], accountType: 'staff', country: 'AR' });
    expect(query).not.toHaveBeenCalled();
  });

  it('só account_type no claim: o papel vem do banco, o tipo é o do claim', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', account_type: 'staff' });
    const { pool, query } = dbWith({ role: 'admin', account_type: 'staff' });
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(query).toHaveBeenCalledTimes(1);
    expect(ctx?.principal).toMatchObject({ roles: ['admin'], accountType: 'staff' });
  });

  it('só role no claim (conta anterior ao backfill): banco sem linha → tipo pela PONTE do papel', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', role: 'community_manager' });
    const { pool } = dbWith(null);
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(ctx?.principal).toMatchObject({ roles: ['community_manager'], accountType: 'staff' });
  });

  it('só role no claim e banco COM linha: a coluna vence a ponte', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', role: 'admin' });
    const { pool } = dbWith({ role: 'admin', account_type: 'worker' });
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(ctx?.principal.accountType).toBe('worker');
  });

  it('sem claim nenhum e sem linha em users (prestador): sem papel e sem tipo — não é staff', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'w1', email: 'w@x.y' });
    const { pool } = dbWith(null);
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(ctx?.principal.roles).toEqual([]);
    expect(ctx?.principal.accountType).toBeUndefined();
  });

  it('claim account_type com valor desconhecido é IGNORADO (cai na ponte, nunca vira staff por acidente)', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', role: 'worker', account_type: 'patient' });
    const { pool } = dbWith(null);
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(ctx?.principal.accountType).toBe('worker');
  });

  it('sem pool: não consulta e segue só com os claims', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const ctx = await new FirebaseAuthStrategy(true).authenticate(credentials, metadata);
    expect(ctx?.principal).toMatchObject({ id: 'u1', roles: [] });
  });

  it('banco fora do ar na consulta → segue sem papel/tipo (não derruba a autenticação)', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const pool = { query: jest.fn().mockRejectedValue(new Error('db')) } as unknown as Pool;
    const ctx = await new FirebaseAuthStrategy(true, pool).authenticate(credentials, metadata);
    expect(ctx?.principal.roles).toEqual([]);
  });

  it('token inválido → null', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('expired'));
    expect(await new FirebaseAuthStrategy(true).authenticate(credentials, metadata)).toBeNull();
  });
});

describe('FirebaseAuthStrategy — emulador (payload do JWT)', () => {
  beforeEach(() => { process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'; });
  afterEach(() => { delete process.env.FIREBASE_AUTH_EMULATOR_HOST; });

  it('lê role, account_type e country do payload', async () => {
    const ctx = await new FirebaseAuthStrategy(true).authenticate({ ...credentials, token: jwt({ user_id: 'e1', role: 'admin', account_type: 'staff', country: 'BR' }) }, metadata);
    expect(ctx?.principal).toMatchObject({ id: 'e1', roles: ['admin'], accountType: 'staff', country: 'BR' });
  });

  it('sem account_type: ponte pelo papel; `sub` serve de id', async () => {
    const ctx = await new FirebaseAuthStrategy(true).authenticate({ ...credentials, token: jwt({ sub: 'e2', role: 'worker' }) }, metadata);
    expect(ctx?.principal).toMatchObject({ id: 'e2', accountType: 'worker' });
  });

  it('payload sem nada → principal anônimo do emulador, sem tipo', async () => {
    const ctx = await new FirebaseAuthStrategy(true).authenticate({ ...credentials, token: jwt({}) }, metadata);
    expect(ctx?.principal).toMatchObject({ id: 'emulator-user', roles: [] });
    expect(ctx?.principal.accountType).toBeUndefined();
  });

  it('token que não é JWT é aceito como emulator-user', async () => {
    const ctx = await new FirebaseAuthStrategy(true).authenticate({ ...credentials, token: 'nao-jwt' }, metadata);
    expect(ctx?.principal.id).toBe('emulator-user');
  });

  it('JWT com payload ilegível → null', async () => {
    const ctx = await new FirebaseAuthStrategy(true).authenticate({ ...credentials, token: 'a.%%%.c' }, metadata);
    expect(ctx).toBeNull();
  });
});
