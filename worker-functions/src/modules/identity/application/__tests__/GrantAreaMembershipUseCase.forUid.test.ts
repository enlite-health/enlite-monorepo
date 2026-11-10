jest.mock('firebase-admin', () => ({
  __esModule: true,
  auth: () => ({ getUser: async (uid: string) => ({ uid, email: `${uid}@ejemplo.com`, customClaims: {} }), setCustomUserClaims: async () => undefined }),
}));

import { GrantAreaMembershipUseCase } from '../GrantAreaMembershipUseCase';

const PID = '00000000-0000-4000-8000-0000000000aa';

function build(ensure: (uid: string) => Promise<string | null>) {
  const grant = jest.fn(async () => 'membership-1');
  const ensurePerson = jest.fn(ensure);
  const uc = new GrantAreaMembershipUseCase(
    { grant, revoke: async () => 0 },
    { hasWorkerInTree: async () => false, storedMemberships: async () => [] },
    { loginUids: async () => ['u-nova'], personOfLogin: async () => PID, identityFromUsers: async () => null },
    { ensurePerson },
  );
  return { uc, grant, ensurePerson };
}

describe('GrantAreaMembershipUseCase.executeForUid', () => {
  it('cria a pessoa do login (ensure_person) e concede o vínculo a ELA', async () => {
    const { uc, grant, ensurePerson } = build(async () => PID);
    const r = await uc.executeForUid({ uid: 'u-nova', area: 'learn', role: 'learner', actorUid: 'staff-1' });
    expect(r.isSuccess).toBe(true);
    expect(ensurePerson).toHaveBeenCalledWith('u-nova');
    expect(grant).toHaveBeenCalledWith(PID, 'learn', 'learner', 'staff-1');
  });

  it('login removido (ensure_person → null): recusa como pessoa inexistente e NÃO concede', async () => {
    const { uc, grant } = build(async () => null);
    const r = await uc.executeForUid({ uid: 'u-nova', area: 'learn', role: 'learner', actorUid: 'staff-1' });
    expect(r.isFailure).toBe(true);
    expect(r.error).toContain('pessoa inexistente');
    expect(grant).not.toHaveBeenCalled();
  });
});
