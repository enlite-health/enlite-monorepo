import { LoggedClientEngine, logClientDecision } from '../clientDecisionLog';
import type { AuthContext } from '../../domain/Auth';

const infoMock = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: (...a: unknown[]) => infoMock(...a) } }));

// Dados 100% sintéticos.
const UID = 'synthetic-uid-9f3a77';
const EMAIL = 'synthetic.person@example.test';
const RES_ID = '00000000-0000-4000-8000-0000000000a1';
const ctx = { principal: { id: UID, email: EMAIL, name: 'Synthetic Name' } } as unknown as AuthContext;

const inner = {
  checkPermission: jest.fn(async () => ({ allowed: true, reason: 'Permitido por política', policies: ['policy0'], auditLogId: 'a1' })),
  checkPermissions: jest.fn(),
  listAccessibleResources: jest.fn(),
};

describe('clientDecisionLog (sem PII)', () => {
  beforeEach(() => infoMock.mockClear());

  it('loga ação, decisão, policyIds, razão, classe da rota e latência', async () => {
    await new LoggedClientEngine(inner as never).checkPermission(ctx, { type: 'Worker', id: RES_ID }, 'ReadOwnWorkerProfile');
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [obj] = infoMock.mock.calls[0];
    expect(obj).toMatchObject({ action: 'ReadOwnWorkerProfile', decision: 'allow', policyIds: ['policy0'], routeClass: 'Worker' });
    expect(typeof obj.latencyMs).toBe('number');
  });

  it('a saída capturada não tem uid, e-mail, nome nem id de recurso', async () => {
    const engine = new LoggedClientEngine(inner as never);
    await engine.checkPermission(ctx, { type: 'Worker', id: RES_ID, attrs: { ownerId: UID } }, 'ReadOwnWorkerProfile');
    inner.checkPermission.mockResolvedValueOnce({ allowed: false, reason: 'Negado (nenhuma política permite)', policies: [], auditLogId: 'a2' });
    await engine.checkPermission(ctx, { type: 'Account' }, 'DeleteOwnAccount');
    const out = JSON.stringify(infoMock.mock.calls);
    expect(out).not.toContain(UID);
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain('Synthetic Name');
    expect(out).not.toContain(RES_ID);
    expect(out).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
    expect(out).not.toContain('"uid"');
  });

  it('logClientDecision só emite a lista fechada de campos', () => {
    logClientDecision({ action: 'x', allowed: false, policyIds: [], reason: 'r', routeClass: 'Worker', latencyMs: 1 });
    expect(Object.keys(infoMock.mock.calls[0][0]).sort()).toEqual(
      ['action', 'decision', 'event', 'latencyMs', 'policyIds', 'reason', 'routeClass'],
    );
  });
});
