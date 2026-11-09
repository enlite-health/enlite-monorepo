import { StaffOrClientEngine } from '../StaffOrClientEngine';
import type { AuthContext } from '../../domain/Auth';

const mk = (tag: string) => ({
  checkPermission: jest.fn(async () => ({ allowed: true, reason: tag, policies: [tag], auditLogId: tag })),
  checkPermissions: jest.fn(),
  listAccessibleResources: jest.fn(),
});

describe('StaffOrClientEngine', () => {
  it('staff vai ao legado; não-staff vai ao engine do cliente', async () => {
    const legacy = mk('legacy');
    const client = mk('client');
    const e = new StaffOrClientEngine(legacy as never, client as never);
    const staff = { principal: { id: 's', accountType: 'staff' } } as unknown as AuthContext;
    const worker = { principal: { id: 'w' } } as unknown as AuthContext;
    expect((await e.checkPermission(staff, { type: 'Worker' }, 'read')).reason).toBe('legacy');
    expect((await e.checkPermission(worker, { type: 'Worker' }, 'read')).reason).toBe('client');
  });
});
