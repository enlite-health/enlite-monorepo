import { StaffOrClientEngine } from '../StaffOrClientEngine';
import type { AuthContext } from '../../domain/Auth';

const mk = (tag: string) => ({
  checkPermission: jest.fn(async () => ({ allowed: tag === 'legacy', reason: tag, policies: [tag], auditLogId: tag })),
  checkPermissions: jest.fn(),
  listAccessibleResources: jest.fn(),
});
const staff = { principal: { id: 's', accountType: 'staff' } } as unknown as AuthContext;
const worker = { principal: { id: 'w' } } as unknown as AuthContext;

describe('StaffOrClientEngine', () => {
  const legacy = mk('legacy');
  const client = mk('client');
  const e = new StaffOrClientEngine(legacy as never, client as never);

  it('staff vai ao legado, mesmo em ação da tabela do Cedar', async () => {
    expect((await e.checkPermission(staff, { type: 'worker' }, 'read')).reason).toBe('legacy');
  });
  it('não-staff + worker:read → Cedar (deny do Cedar vale)', async () => {
    const r = await e.checkPermission(worker, { type: 'worker', id: 'outro' }, 'read');
    expect(r.reason).toBe('client');
    expect(r.allowed).toBe(false);
  });
  it('não-staff + ação fora da tabela → decisão do legado (F2 não bloqueia por padrão)', async () => {
    const r = await e.checkPermission(worker, { type: 'vacancy' }, 'read');
    expect(r.reason).toBe('legacy');
    expect(r.allowed).toBe(true);
  });
});
