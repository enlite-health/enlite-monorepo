import {
  CedarClientPolicyEngine,
  ClientEntityProvider,
} from '../CedarClientPolicyEngine';
import { AuthContext } from '../../domain/Auth';
import { CLIENT_SCHEMA as schema } from '../policies/schema';

// Dados 100% sintéticos.
const PID = '00000000-0000-4000-8000-000000000001';
const WID = '00000000-0000-4000-8000-0000000000a1';
const ctx = { principal: { id: 'synthetic-uid' } } as unknown as AuthContext;

const provider: ClientEntityProvider = {
  async load() {
    return {
      principal: { type: 'Person', id: PID },
      resource: { type: 'Worker', id: WID },
      entities: [
        { uid: { type: 'Person', id: PID }, attrs: { areas: ['care:worker'] }, parents: [] },
        {
          uid: { type: 'Worker', id: WID },
          attrs: { owner: { __entity: { type: 'Person', id: PID } } },
          parents: [],
        },
      ],
    };
  },
};

const PERMIT = `permit(principal is Person, action == Action::"ReadOwnWorkerProfile", resource is Worker)
  when { resource.owner == principal };`;

const build = (policies: string, p = provider) =>
  new CedarClientPolicyEngine({ schema, policies, entityProvider: p });
const res = { type: 'Worker', id: WID };

describe('CedarClientPolicyEngine', () => {
  it('carrega o wasm no jest (versão 4.14.0)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cedar = require('@cedar-policy/cedar-wasm/nodejs');
    expect(cedar.getCedarVersion()).toBe('4.14.0');
  });

  it('sem política: deny por padrão', async () => {
    const d = await build('').checkPermission(ctx, res, 'ReadOwnWorkerProfile');
    expect(d.allowed).toBe(false);
  });

  it('com permit mínimo: allow, com o id da política', async () => {
    const d = await build(PERMIT).checkPermission(ctx, res, 'ReadOwnWorkerProfile');
    expect(d.allowed).toBe(true);
    expect(d.policies).toEqual(['policy0']);
  });

  it('permit de outra ação não vaza: deny', async () => {
    const d = await build(PERMIT).checkPermission(ctx, res, 'UpdateOwnWorkerProfile');
    expect(d.allowed).toBe(false);
  });

  it('recurso de outro dono: deny', async () => {
    const other: ClientEntityProvider = {
      async load(...a) {
        const r = await provider.load(...a);
        (r.entities[1] as any).attrs.owner = {
          __entity: { type: 'Person', id: '00000000-0000-4000-8000-000000000002' },
        };
        return r;
      },
    };
    const d = await build(PERMIT, other).checkPermission(ctx, res, 'ReadOwnWorkerProfile');
    expect(d.allowed).toBe(false);
  });

  it('carregador que falha: deny, não lança', async () => {
    const boom: ClientEntityProvider = { load: async () => { throw new Error('x'); } };
    const d = await build(PERMIT, boom).checkPermission(ctx, res, 'ReadOwnWorkerProfile');
    expect(d.allowed).toBe(false);
  });

  it('schema que não valida: falha cedo', () => {
    expect(
      () => new CedarClientPolicyEngine({ schema: 'entity {', policies: '', entityProvider: provider })
    ).toThrow(/schema inválido/);
  });

  it('política que não valida contra o schema: falha cedo', () => {
    expect(() => build('permit(principal, action, resource) when { principal.nope };')).toThrow(
      /não valida/
    );
  });

  it('checkPermissions e listAccessibleResources seguem a interface', async () => {
    const e = build(PERMIT);
    const r = await e.checkPermissions(ctx, [
      { resource: res, action: 'ReadOwnWorkerProfile' },
      { resource: res, action: 'UpdateOwnWorkerProfile' },
    ]);
    expect(r.map((x) => x.allowed)).toEqual([true, false]);
    expect((await e.listAccessibleResources(ctx, 'Worker', 'ReadOwnWorkerProfile')).decision.allowed).toBe(false);
  });
});
