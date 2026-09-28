import { canAllocate } from '../itineraryAllocationGate';
import { deriveServiceTeam, SERVICE_TEAM_ENTRY_STAGE } from '../deriveServiceTeam';

/**
 * itineraryAllocationGate — P7, DX-11.6. `team` sempre vem de `deriveServiceTeam` REAL (nunca
 * montado à mão) — se a derivação de Selecionado/Em Atendimento mudar, este teste quebra junto,
 * em vez de continuar verde com uma cópia congelada da regra antiga.
 */
describe('canAllocate', () => {
  const SERVICE_ID = 'service-1';
  const VACANCY_ID = 'vacancy-1';
  const ASOF = '2026-09-28';

  it('em selected (candidato da vaga viva, nem alocado nem rejeitado) → true', () => {
    const team = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [],
      marks: [],
    });

    expect(canAllocate(team, new Set(['w1']), 'w1')).toBe(true);
  });

  it('sem candidatura nenhuma (fora de toda lista, fora de candidacyWorkerIds) → false', () => {
    const team = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [],
      marks: [],
    });

    expect(canAllocate(team, new Set(), 'w1')).toBe(false);
  });

  it('candidato só em outra etapa do quadro B (fora de candidacyWorkerIds, fora de selected) → false', () => {
    const team = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: 'SELECTED' }],
      assignments: [],
      marks: [],
    });

    expect(team.selected).toEqual([]);
    expect(canAllocate(team, new Set(), 'w1')).toBe(false);
  });

  it('em rejected → false', () => {
    const team = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [],
      marks: [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
    });

    expect(canAllocate(team, new Set(['w1']), 'w1')).toBe(false);
  });

  it('em inService E em candidacyWorkerIds (2º slot do mesmo serviço, Q-11.3) → true', () => {
    const team = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
    });

    expect(team.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(canAllocate(team, new Set(['w1']), 'w1')).toBe(true);
  });

  it('em inService e FORA de candidacyWorkerIds (a candidatura saiu de Equipe de Resposta Rápida) → false', () => {
    const team = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
    });

    expect(team.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(canAllocate(team, new Set(), 'w1')).toBe(false);
  });
});
