/**
 * `isLiveSimulation` — as duas condições de "viva": aberta (`endedAt === null`)
 * e dentro do prazo (`expiresAt > now`). O banco (`iam.active_group_simulation`,
 * mig 458) já filtra as duas antes de qualquer linha voltar; esta é a MESMA
 * regra em TS, para quem olha a linha crua sem duplicar o predicado.
 */

import { isLiveSimulation, type GroupSimulation } from '../GroupSimulation';

function sim(overrides: Partial<GroupSimulation & { endedAt: Date | null }> = {}) {
  return {
    id: 'sim-1',
    groupId: 'g2',
    groupName: 'Recrutamento AR',
    startedAt: new Date('2026-09-22T18:00:00Z'),
    expiresAt: new Date('2026-09-22T22:00:00Z'),
    endedAt: null as Date | null,
    ...overrides,
  };
}

describe('isLiveSimulation', () => {
  it('aberta e dentro do prazo é viva', () => {
    expect(isLiveSimulation(sim(), new Date('2026-09-22T19:00:00Z'))).toBe(true);
  });

  it('fechada (endedAt preenchido) não é viva mesmo dentro do prazo', () => {
    expect(
      isLiveSimulation(sim({ endedAt: new Date('2026-09-22T19:00:00Z') }), new Date('2026-09-22T19:30:00Z')),
    ).toBe(false);
  });

  it('aberta mas vencida (expiresAt <= now) não é viva', () => {
    expect(isLiveSimulation(sim(), new Date('2026-09-22T22:00:00Z'))).toBe(false);
    expect(isLiveSimulation(sim(), new Date('2026-09-22T23:00:00Z'))).toBe(false);
  });
});
