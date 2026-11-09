import { CedarClientPolicyEngine } from '../CedarClientPolicyEngine';
import { ClientEntityLoader, type ClientOwnershipReader, type PersonBootstrap } from '../ClientEntityLoader';
import type { AreaRegistryReader } from '../../application/ListPersonAreasUseCase';
import type { AuthContext } from '../../domain/Auth';
import { CLIENT_POLICIES as POLICIES, CLIENT_SCHEMA as schema } from '../policies';
// Dados 100% sintéticos: A e B são a mesma pessoa (B foi absorvida: raiz = P1); P2 é outra pessoa.
const P1 = '00000000-0000-4000-8000-000000000001';
const P1_ABSORBED = '00000000-0000-4000-8000-000000000011';
const P2 = '00000000-0000-4000-8000-000000000002';
const W1 = '00000000-0000-4000-8000-0000000000a1'; // ficha de P1
const W2 = '00000000-0000-4000-8000-0000000000a2'; // ficha de P2
const LOGIN_PERSON: Record<string, string> = { 'uid-a': P1, 'uid-b': P1_ABSORBED, 'uid-c': P2 };
const ROOT: Record<string, string> = { [P1]: P1, [P1_ABSORBED]: P1, [P2]: P2 };
const WORKER_OWNER: Record<string, string> = { [W1]: P1, [W2]: P2 };

const bootstrap: PersonBootstrap = { ensurePerson: async (uid) => LOGIN_PERSON[uid] ?? null };
const registry: AreaRegistryReader = {
  hasWorkerInTree: async () => true,
  storedMemberships: async (pid) => (pid === P1 ? [{ area: 'learn', role: 'learner' }] : []),
};
const ownership: ClientOwnershipReader = {
  rootOf: async (pid) => ROOT[pid] ?? null,
  workerOwnerRoot: async (id) => WORKER_OWNER[id] ?? null,
};

const ctx = (uid: string) => ({ principal: { id: uid, roles: [], accountType: 'worker' } }) as unknown as AuthContext;
const loader = () => new ClientEntityLoader(bootstrap, registry, ownership);
const engine = () => new CedarClientPolicyEngine({ schema, policies: POLICIES, entityProvider: loader() });

describe('ClientEntityLoader', () => {
  it('o principal é Person::"<pid>" da pessoa, nunca o uid do token', async () => {
    const req = await loader().load(ctx('uid-a'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile');
    expect(req.principal).toEqual({ type: 'Person', id: P1 });
    expect(req.principal.id).not.toBe('uid-a');
  });

  it('dois logins da mesma pessoa montam o mesmo principal', async () => {
    const a = await loader().load(ctx('uid-a'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile');
    const b = await loader().load(ctx('uid-b'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile');
    expect(b.principal).toEqual(a.principal);
  });

  it('login absorvido por merge decide como a sobrevivente (lê a ficha dela)', async () => {
    const d = await engine().checkPermission(ctx('uid-b'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile');
    expect(d.allowed).toBe(true);
  });

  it('o próprio prestador lê a própria ficha; a ficha de outra pessoa é negada', async () => {
    expect((await engine().checkPermission(ctx('uid-a'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile')).allowed).toBe(true);
    expect((await engine().checkPermission(ctx('uid-a'), { type: 'Worker', id: W2 }, 'ReadOwnWorkerProfile')).allowed).toBe(false);
  });

  it('ficha inexistente nega', async () => {
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    expect((await engine().checkPermission(ctx('uid-a'), { type: 'Worker', id: ghost }, 'ReadOwnWorkerProfile')).allowed).toBe(false);
  });

  it('Person.areas soma as fontes (care:worker derivado + registro)', async () => {
    const req = await loader().load(ctx('uid-a'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile');
    const person = (req.entities as Array<{ uid: { type: string }; attrs: { areas: string[] } }>).find((e) => e.uid.type === 'Person');
    expect([...person!.attrs.areas].sort()).toEqual(['care:worker', 'learn:learner']);
  });

  it('Account vem do token: ignora o id do recurso pedido e carrega tokenUid', async () => {
    const req = await loader().load(ctx('uid-a'), { type: 'Account', id: 'uid-c' }, 'DeleteOwnAccount');
    expect(req.resource).toEqual({ type: 'Account', id: 'uid-a' });
    expect(req.context).toEqual({ tokenUid: 'uid-a' });
    const d = await engine().checkPermission(ctx('uid-a'), { type: 'Account', id: 'uid-c' }, 'DeleteOwnAccount');
    expect(d.allowed).toBe(true);
  });

  it('login sem pessoa viva (removido) lança e o engine nega', async () => {
    await expect(loader().load(ctx('uid-x'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile')).rejects.toThrow();
    expect((await engine().checkPermission(ctx('uid-x'), { type: 'Worker', id: W1 }, 'ReadOwnWorkerProfile')).allowed).toBe(false);
  });
});
