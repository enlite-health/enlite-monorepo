import { canAllocate } from '../itineraryAllocationGate';
import { deriveAllocationPool, type DeriveServiceTeamInput } from '../deriveServiceTeam';

/**
 * itineraryAllocationGate — 041 R1. O pool vem de `deriveAllocationPool` REAL (nunca montado à mão):
 * se a regra "step final da vacante" mudar, este teste quebra junto, em vez de continuar verde com
 * uma cópia congelada.
 */
describe('canAllocate (pool do step final da vacante)', () => {
  const SERVICE_ID = 'service-1';
  const VACANCY_ID = 'vacancy-1';
  const base = (over: Partial<DeriveServiceTeamInput>): DeriveServiceTeamInput => ({
    serviceId: SERVICE_ID,
    liveVacancyId: VACANCY_ID,
    asOf: '2026-09-28',
    candidacies: [],
    assignments: [],
    marks: [],
    ...over,
  });
  const cand = (workerId: string, stage: string) => ({ workerId, vacancyId: VACANCY_ID, stage });

  it('só em "Selecionados" (SELECTED) → true (o caso que morria quando o gate era team.selected)', () => {
    const pool = deriveAllocationPool(base({ candidacies: [cand('w1', 'SELECTED')] }));
    expect(canAllocate(pool, 'w1')).toBe(true);
  });

  it('em "Equipe de Resposta Rápida" → true', () => {
    const pool = deriveAllocationPool(base({ candidacies: [cand('w1', 'QUICK_RESPONSE_TEAM')] }));
    expect(canAllocate(pool, 'w1')).toBe(true);
  });

  it('rejeitado no serviço, mesmo em Selecionados → false', () => {
    const pool = deriveAllocationPool(
      base({ candidacies: [cand('w1', 'SELECTED')], marks: [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }] }),
    );
    expect(canAllocate(pool, 'w1')).toBe(false);
  });

  it('em coluna anterior do funil (CONFIRMED) → false', () => {
    const pool = deriveAllocationPool(base({ candidacies: [cand('w1', 'CONFIRMED')] }));
    expect(canAllocate(pool, 'w1')).toBe(false);
  });

  it('já alocado E ainda numa das colunas (2º slot do mesmo serviço, Q-11.3) → true', () => {
    const pool = deriveAllocationPool(
      base({
        candidacies: [cand('w1', 'SELECTED')],
        assignments: [{ workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
      }),
    );
    expect(canAllocate(pool, 'w1')).toBe(true);
  });

  it('já alocado mas FORA das duas colunas (saiu do funil) → false', () => {
    const pool = deriveAllocationPool(
      base({
        assignments: [{ workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
      }),
    );
    expect(canAllocate(pool, 'w1')).toBe(false);
  });

  it('candidato em SELECTED de OUTRA vaga (não a viva) → false', () => {
    const pool = deriveAllocationPool(base({ candidacies: [{ workerId: 'w1', vacancyId: 'outra', stage: 'SELECTED' }] }));
    expect(canAllocate(pool, 'w1')).toBe(false);
  });
});
