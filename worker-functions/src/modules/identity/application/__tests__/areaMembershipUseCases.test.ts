const mockGetUser = jest.fn();
const mockSetCustomUserClaims = jest.fn();
const mockRevoke = jest.fn();

jest.mock('firebase-admin', () => ({
  __esModule: true,
  auth: () => ({ getUser: mockGetUser, setCustomUserClaims: mockSetCustomUserClaims, revokeRefreshTokens: mockRevoke }),
}));

import { GrantAreaMembershipUseCase, type AreaMembershipWriter } from '../GrantAreaMembershipUseCase';
import { RevokeAreaMembershipUseCase } from '../RevokeAreaMembershipUseCase';
import type { AreaRegistryReader, StoredMembership } from '../ListPersonAreasUseCase';
import type { LoginDirectory } from '../../infrastructure/areasClaim';

const PID = '00000000-0000-4000-8000-000000000001';
const ACTOR = 'actor-uid';

/** Registro dublê mutável: o `writer` mexe nele como o banco mexeria. */
function world(opts: { uids: string[]; claims: Record<string, Record<string, unknown>>; workerInTree?: boolean; stored?: StoredMembership[]; usersDb?: Record<string, { role: string | null; account_type: string | null }> }) {
  const stored = [...(opts.stored ?? [])];
  const registry: AreaRegistryReader = {
    hasWorkerInTree: async () => opts.workerInTree ?? false,
    storedMemberships: async () => stored.map((s) => ({ ...s })),
  };
  const writer: AreaMembershipWriter = {
    grant: async (_p, area, role) => {
      stored.push({ area, role });
      return 'membership-1';
    },
    revoke: async (_p, area, role) => {
      const i = stored.findIndex((s) => s.area === area && s.role === role);
      if (i >= 0) stored.splice(i, 1);
      return i >= 0 ? 1 : 0;
    },
  };
  const logins: LoginDirectory = {
    loginUids: async () => opts.uids,
    identityFromUsers: async (uid) => opts.usersDb?.[uid] ?? null,
  };
  mockGetUser.mockImplementation(async (uid: string) => ({ uid, customClaims: opts.claims[uid] ?? {} }));
  return { registry, writer, logins };
}

const lastClaims = (uid: string) => mockSetCustomUserClaims.mock.calls.filter((c) => c[0] === uid).pop()?.[1];

describe('Grant/RevokeAreaMembership + claim areas (Firebase dublê)', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSetCustomUserClaims.mockReset().mockResolvedValue(undefined);
    mockRevoke.mockReset().mockResolvedValue(undefined);
  });

  it('concede: claim areas = recálculo do registro e pid = pessoa; preserva role/country', async () => {
    const w = world({ uids: ['u1'], claims: { u1: { role: 'worker', account_type: 'worker', country: 'AR' } }, workerInTree: true });
    const r = await new GrantAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'care', role: 'family', actorUid: ACTOR });
    expect(r.isSuccess).toBe(true);
    expect(lastClaims('u1')).toEqual({ role: 'worker', account_type: 'worker', country: 'AR', pid: PID, areas: { care: ['family', 'worker'] } });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('revoga um de dois papéis: o claim fica com o que sobrou (recálculo inteiro, não patch incremental)', async () => {
    // claim ANTIGO no token já carrega os dois papéis learn; o registro, depois da revogação, só tem 'learner'.
    const w = world({
      uids: ['u1'],
      claims: { u1: { account_type: 'worker', role: 'worker', areas: { learn: ['learner', 'teacher'] } } },
      stored: [{ area: 'learn', role: 'learner' }, { area: 'learn', role: 'teacher' }],
    });
    const r = await new RevokeAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'learn', role: 'teacher', actorUid: ACTOR, reason: 'saiu do curso' });
    expect(r.isSuccess).toBe(true);
    expect(lastClaims('u1').areas).toEqual({ learn: ['learner'] });
  });

  it('revoga a última área: o claim areas é esvaziado (a chave antiga não sobrevive)', async () => {
    const w = world({ uids: ['u1'], claims: { u1: { areas: { learn: ['learner'] } } }, stored: [{ area: 'learn', role: 'learner' }] });
    await new RevokeAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'learn', role: 'learner', actorUid: ACTOR, reason: 'fim' });
    expect(lastClaims('u1').areas).toEqual({});
  });

  it('revoga: revokeRefreshTokens 1x em CADA login vivo; conceder não revoga', async () => {
    const w = world({ uids: ['u1', 'u2', 'u3'], claims: {}, stored: [{ area: 'learn', role: 'learner' }] });
    await new RevokeAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'learn', role: 'learner', actorUid: ACTOR, reason: 'fim' });
    expect(mockRevoke.mock.calls.map((c) => c[0]).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(mockSetCustomUserClaims).toHaveBeenCalledTimes(3);
  });

  it('V1: na mesma pessoa, o login staff recebe backoffice e o login não-staff NÃO recebe', async () => {
    const w = world({
      uids: ['staff-login', 'worker-login'],
      claims: { 'staff-login': { account_type: 'staff', role: 'admin' }, 'worker-login': { account_type: 'worker', role: 'worker' } },
      workerInTree: true,
    });
    await new GrantAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'learn', role: 'learner', actorUid: ACTOR });
    expect(lastClaims('staff-login').areas).toEqual({ backoffice: ['staff'], care: ['worker'], learn: ['learner'] });
    expect(lastClaims('worker-login').areas).toEqual({ care: ['worker'], learn: ['learner'] });
  });

  it('V1: claim que falta cai no fallback de `users` (mesmo do portão): staff só no banco recebe backoffice', async () => {
    const w = world({ uids: ['old'], claims: { old: {} }, usersDb: { old: { role: 'admin', account_type: 'staff' } } });
    await new GrantAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'learn', role: 'learner', actorUid: ACTOR });
    expect(lastClaims('old').areas.backoffice).toEqual(['staff']);
  });

  it('teto de 1000 bytes: o pior caso (4 áreas+pid) cabe; ao passar, RECUSA com erro explícito e não grava nada', async () => {
    const worst = world({
      uids: ['u1'],
      claims: { u1: { role: 'admin', account_type: 'staff', country: 'AR' } },
      workerInTree: true,
      stored: [{ area: 'care', role: 'family' }, { area: 'learn', role: 'learner' }, { area: 'learn', role: 'teacher' }],
    });
    await new GrantAreaMembershipUseCase(worst.writer, worst.registry, worst.logins).execute({ pid: PID, area: 'learn', role: 'manager', actorUid: ACTOR });
    expect(Buffer.byteLength(JSON.stringify(lastClaims('u1')), 'utf8')).toBeLessThanOrEqual(1000);

    mockSetCustomUserClaims.mockClear();
    const big = world({ uids: ['u1', 'u2'], claims: { u1: {}, u2: { lixo: 'x'.repeat(1100) } } });
    const grantSpy = jest.spyOn(big.writer, 'grant');
    const r = await new GrantAreaMembershipUseCase(big.writer, big.registry, big.logins).execute({ pid: PID, area: 'learn', role: 'learner', actorUid: ACTOR });
    expect(r.isFailure).toBe(true);
    expect(r.error).toMatch(/1000 bytes/);
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(grantSpy).not.toHaveBeenCalled(); // pré-checagem: o banco não é tocado
  });

  it('falha de Firebase em um login não impede os outros e aparece em failedUids', async () => {
    const w = world({ uids: ['u1', 'u2'], claims: {}, stored: [{ area: 'learn', role: 'learner' }] });
    mockSetCustomUserClaims.mockImplementation(async (uid: string) => { if (uid === 'u1') throw new Error('boom'); });
    const r = await new RevokeAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area: 'learn', role: 'learner', actorUid: ACTOR, reason: 'fim' });
    expect(r.getValue().failedUids).toEqual(['u1']);
    expect(mockRevoke).toHaveBeenCalledWith('u2');
  });

  it('par não gravável (care·worker, backoffice·staff, clinic) é recusado antes de tocar o banco', async () => {
    const w = world({ uids: ['u1'], claims: {} });
    const spy = jest.spyOn(w.writer, 'grant');
    for (const [area, role] of [['care', 'worker'], ['backoffice', 'staff'], ['clinic', 'x']]) {
      const r = await new GrantAreaMembershipUseCase(w.writer, w.registry, w.logins).execute({ pid: PID, area, role, actorUid: ACTOR });
      expect(r.isFailure).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
