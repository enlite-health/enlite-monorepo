import { describe, it, expect } from 'vitest';
import { isSimulating, type AuthzContract } from '../Authz';

/**
 * F3/T3.1 (spec 026) — extensão do contrato de authz para simulação de grupo.
 * `canSimulate`: filiação REAL no Master (não muda com a simulação ativa).
 * `simulation`: null quando não há simulação ativa; senão, o snapshot vindo
 * do backend (`GET /v1/me/authz`), com `startedAt`/`expiresAt` em ISO string.
 */

const base: AuthzContract = {
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions: [],
  countries: ['AR'],
  groups: [{ id: 'g1', name: 'G' }],
  features: {},
  enforcement: 'on',
  canSimulate: false,
  simulation: null,
};

const simulacaoAtiva = {
  id: 's1',
  groupId: 'g-recl',
  groupName: 'Reclutamiento - AG',
  startedAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2026-09-23T14:00:00.000Z',
};

describe('isSimulating — pura (F3/T3.1)', () => {
  // Cada teste passa a fixture ESTENDIDA (canSimulate + simulation) por USO
  // NORMAL do tipo `AuthzContract` — é a prova de tipo pedida no contrato, sem
  // um teste à parte que só compilaria e passaria à toa sem `isSimulating`
  // existir (achado ao rodar RED: 2 testes "de tipo" passavam vazios).
  it('true quando authz.simulation não é null — e o fixture com canSimulate/simulation compila via uso normal', () => {
    const authz: AuthzContract = { ...base, canSimulate: true, simulation: simulacaoAtiva };
    expect(authz.canSimulate).toBe(true);
    expect(authz.simulation?.groupName).toBe('Reclutamiento - AG');
    expect(isSimulating(authz)).toBe(true);
  });

  it('false quando authz.simulation é null (null explícito, não ausência)', () => {
    const authz: AuthzContract = { ...base, canSimulate: true, simulation: null };
    expect(authz.simulation).toBeNull();
    expect(isSimulating(authz)).toBe(false);
  });

  it('false quando authz é null', () => {
    expect(isSimulating(null)).toBe(false);
  });
});
