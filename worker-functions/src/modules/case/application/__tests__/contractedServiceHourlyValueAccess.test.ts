/**
 * contractedServiceHourlyValueAccess — hourlyValue redigido para quem não é admin (lex C-c.4).
 */
import {
  isAdminActor,
  actorRolesOf,
  projectContractedServiceForActor,
} from '../contractedServiceHourlyValueAccess';
import type { Request } from 'express';

describe('isAdminActor', () => {
  it('roles null/undefined → true (defesa; requireStaff já filtrou)', () => {
    expect(isAdminActor(null)).toBe(true);
    expect(isAdminActor(undefined)).toBe(true);
  });
  it('roles inclui admin → true', () => {
    expect(isAdminActor(['admin'])).toBe(true);
    expect(isAdminActor(['recruiter', 'admin'])).toBe(true);
  });
  it('roles sem admin → false', () => {
    expect(isAdminActor(['recruiter'])).toBe(false);
    expect(isAdminActor(['community_manager'])).toBe(false);
    expect(isAdminActor([])).toBe(false);
  });
});

describe('actorRolesOf', () => {
  it('lê req.user.roles', () => {
    const req = { user: { roles: ['admin'] } } as unknown as Request;
    expect(actorRolesOf(req)).toEqual(['admin']);
  });
  it('req.user ausente → null', () => {
    const req = {} as unknown as Request;
    expect(actorRolesOf(req)).toBeNull();
  });
  it('req.user.roles ausente → null', () => {
    const req = { user: {} } as unknown as Request;
    expect(actorRolesOf(req)).toBeNull();
  });
});

describe('projectContractedServiceForActor', () => {
  const service = { id: 's1', hourlyValue: 1500 };

  it('admin: devolve o valor cru, hourlyValueRedacted:false', () => {
    const out = projectContractedServiceForActor(service, ['admin']);
    expect(out).toEqual({ id: 's1', hourlyValue: 1500, hourlyValueRedacted: false });
  });

  it('não-admin: hourlyValue vira null, hourlyValueRedacted:true', () => {
    const out = projectContractedServiceForActor(service, ['recruiter']);
    expect(out).toEqual({ id: 's1', hourlyValue: null, hourlyValueRedacted: true });
  });

  it('roles null (defesa) → tratado como admin', () => {
    const out = projectContractedServiceForActor(service, null);
    expect(out.hourlyValueRedacted).toBe(false);
    expect(out.hourlyValue).toBe(1500);
  });

  it('hourlyValue já null (não informado) + não-admin: continua null, mas com o flag', () => {
    const out = projectContractedServiceForActor({ id: 's2', hourlyValue: null }, ['community_manager']);
    expect(out).toEqual({ id: 's2', hourlyValue: null, hourlyValueRedacted: true });
  });
});
