import { deriveServiceTeam, SERVICE_TEAM_ENTRY_STAGE } from '../deriveServiceTeam';

/**
 * deriveServiceTeam — um `it(` por caso nomeado do critério 1 (DX-10.4, P6), mais os de
 * borda. `SERVICE_ID`/`VACANCY_ID` são o serviço e a vaga viva sob teste; `OTHER_*` é o
 * serviço/vaga de outro paciente (critério 7 desta suíte).
 */
describe('deriveServiceTeam', () => {
  const SERVICE_ID = 'service-1';
  const VACANCY_ID = 'vacancy-1';
  const OTHER_SERVICE_ID = 'service-2';
  const OTHER_VACANCY_ID = 'vacancy-2';
  const ASOF = '2026-09-28';

  it('(1) candidato sem alocação → Selecionado', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [],
      marks: [],
    });
    expect(result.selected).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(result.inService).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('(2) alocado → Em Atendimento', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
    });
    expect(result.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('(3) marcado → Rejeitado', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [],
      marks: [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
    });
    expect(result.rejected).toEqual([{ workerId: 'w1', reasonCategory: 'OTHER' }]);
    expect(result.selected).toEqual([]);
    expect(result.inService).toEqual([]);
  });

  it('(4) candidatura que sai de QUICK_RESPONSE_TEAM → some de Selecionado', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: 'REJECTED' }],
      assignments: [],
      marks: [],
    });
    expect(result.selected).toEqual([]);
  });

  it('(5) alocação encerrada → volta a Selecionado', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-08-01', validTo: '2026-09-01', status: 'ENDED' },
      ],
      marks: [],
    });
    expect(result.selected).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(result.inService).toEqual([]);
  });

  it('(6) QUICK_RESPONSE_TEAM na vaga de OUTRO serviço do mesmo paciente → não aparece', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: OTHER_VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [],
      marks: [],
    });
    expect(result.selected).toEqual([]);
  });

  it('(7) prestador de OUTRO paciente → não aparece', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: OTHER_SERVICE_ID, vacancyId: OTHER_VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [{ workerId: 'w2', serviceId: OTHER_SERVICE_ID, rejectReasonCategory: 'OTHER' }],
    });
    expect(result.inService).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('(8) as três listas são disjuntas — candidato+alocado+marcado só em inService', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
    });
    expect(result.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([]);

    const selectedIds = new Set(result.selected.map((s) => s.workerId));
    const inServiceIds = new Set(result.inService.map((s) => s.workerId));
    const rejectedIds = new Set(result.rejected.map((s) => s.workerId));
    const intersection = [...selectedIds].filter((id) => inServiceIds.has(id) && rejectedIds.has(id));
    expect(intersection).toEqual([]);
  });

  it('(9) sem vaga viva → Selecionado vazio', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: null,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [],
      marks: [],
    });
    expect(result.selected).toEqual([]);
  });

  it('(10) alocação ACTIVE com validFrom no futuro não conta', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-10-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
    });
    expect(result.inService).toEqual([]);
    expect(result.selected).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
  });

  it('(11) marcado e alocado: fica em Em Atendimento; desalocado, volta a Rejeitado', () => {
    const marks = [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' as const }];

    const alocado = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks,
    });
    expect(alocado.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(alocado.rejected).toEqual([]);

    const desalocado = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: '2026-09-15', status: 'ENDED' },
      ],
      marks,
    });
    expect(desalocado.inService).toEqual([]);
    expect(desalocado.rejected).toEqual([{ workerId: 'w1', reasonCategory: 'OTHER' }]);
  });

  it('(12) sem repetição de workerId', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [
        { workerId: 'w3', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE },
        { workerId: 'w3', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE },
      ],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-10', validTo: null, status: 'ACTIVE' },
      ],
      marks: [
        { workerId: 'w2', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' },
        { workerId: 'w2', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' },
      ],
    });
    expect(result.inService).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.selected).toHaveLength(1);
  });
});
