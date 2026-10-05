import { deriveAllocationPool, deriveServiceTeam, type DeriveServiceTeamInput } from '../deriveServiceTeam';

/** deriveAllocationPool — 041 R1 (DEC-04/DEC-05, Q2/Q3). */
describe('deriveAllocationPool', () => {
  const SERVICE_ID = 'service-1';
  const VAC = 'vac-live';
  const input = (over: Partial<DeriveServiceTeamInput>): DeriveServiceTeamInput => ({
    serviceId: SERVICE_ID,
    liveVacancyId: VAC,
    asOf: '2026-09-28',
    candidacies: [],
    assignments: [],
    marks: [],
    ...over,
  });
  const cand = (workerId: string, stage: string, vacancyId = VAC) => ({ workerId, vacancyId, stage });
  const alloc = (workerId: string) => ({
    workerId, serviceId: SERVICE_ID, vacancyId: VAC, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' as const,
  });

  it('inclui SELECTED, QUICK_RESPONSE_TEAM e alocados; exclui rejeitados e coluna anterior; ordem IN_SERVICE → QUICK_RESPONSE → SELECTED', () => {
    const pool = deriveAllocationPool(
      input({
        candidacies: [
          cand('w-sel', 'SELECTED'),
          cand('w-qrt', 'QUICK_RESPONSE_TEAM'),
          cand('w-atendendo', 'QUICK_RESPONSE_TEAM'),
          cand('w-rej', 'SELECTED'),
          cand('w-confirmado', 'CONFIRMED'),
          cand('w-outra-vaga', 'SELECTED', 'vac-velha'),
        ],
        assignments: [alloc('w-atendendo')],
        marks: [{ workerId: 'w-rej', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
      }),
    );
    expect(pool).toEqual([
      { workerId: 'w-atendendo', vacancyId: VAC, status: 'IN_SERVICE' },
      { workerId: 'w-qrt', vacancyId: VAC, status: 'QUICK_RESPONSE' },
      { workerId: 'w-sel', vacancyId: VAC, status: 'SELECTED' },
    ]);
  });

  it('IN_SERVICE prevalece sobre a coluna (alocado em SELECTED também é IN_SERVICE)', () => {
    const pool = deriveAllocationPool(input({ candidacies: [cand('w1', 'SELECTED')], assignments: [alloc('w1')] }));
    expect(pool).toEqual([{ workerId: 'w1', vacancyId: VAC, status: 'IN_SERVICE' }]);
  });

  it('sem vaga viva → pool vazio', () => {
    expect(deriveAllocationPool(input({ liveVacancyId: null, candidacies: [cand('w1', 'SELECTED')] }))).toEqual([]);
  });

  it('o quadro C NÃO muda: team.selected continua só QUICK_RESPONSE_TEAM (SELECTED fica fora)', () => {
    const team = deriveServiceTeam(input({ candidacies: [cand('w-sel', 'SELECTED'), cand('w-qrt', 'QUICK_RESPONSE_TEAM')] }));
    expect(team.selected.map((e) => e.workerId)).toEqual(['w-qrt']);
  });

  it('nome repetido na mesma vaga em duas colunas fica uma vez, na mais avançada', () => {
    const pool = deriveAllocationPool(input({ candidacies: [cand('w1', 'SELECTED'), cand('w1', 'QUICK_RESPONSE_TEAM')] }));
    expect(pool).toEqual([{ workerId: 'w1', vacancyId: VAC, status: 'QUICK_RESPONSE' }]);
  });
});
