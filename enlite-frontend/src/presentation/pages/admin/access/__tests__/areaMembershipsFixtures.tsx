import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { AreaPeoplePage, AreaPerson } from '@domain/entities/AreaMembership';

/** Células do ator, ligando a régua (`enforcement: 'on'`). */
export function cells(permissions: string[]): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
  });
}

export const PID_ANA = '11111111-1111-4111-8111-111111111111';
export const MID_ANA = '22222222-2222-4222-8222-222222222222';

/** Pessoa 100% sintética: worker com um vínculo vivo (care · family). */
export const ANA: AreaPerson = {
  personId: PID_ANA,
  uid: 'uid-ana',
  displayName: 'Ana Ejemplo',
  email: 'ana.ejemplo@ejemplo.com',
  kind: 'worker',
  memberships: [{ id: MID_ANA, area: 'care', role: 'family' }],
};

export const BETO: AreaPerson = {
  personId: '33333333-3333-4333-8333-333333333333',
  uid: 'uid-beto',
  displayName: 'Beto Ejemplo',
  email: 'beto.ejemplo@ejemplo.com',
  kind: 'staff',
  memberships: [],
};

/** Conta de login que nunca virou pessoa: só `uid`, a concessão vai por ele. */
export const CUENTA: AreaPerson = {
  personId: null,
  uid: 'uid-cuenta',
  displayName: 'Cuenta sin ficha',
  email: 'algo@ejemplo.com',
  kind: 'account',
  memberships: [],
};

export function pagina(items: AreaPerson[], total = items.length, limit = 20, offset = 0): AreaPeoplePage {
  return { items, total, limit, offset };
}
