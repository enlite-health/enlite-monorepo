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

  /**
   * Gate parcial #1 (achado 1 do veredito): o (8) só provava a interseção TRIPLA
   * (selected ∩ inService ∩ rejected), que a sabotagem A (remover `!rejectedWorkerIds.has` de
   * `deriveServiceTeam.ts:~108`) não derruba — o caso real da operação é o PAR "candidato que
   * virou rejeitado", não a tripla. Os três `it(` abaixo cobrem os pares nomeados no gate.
   */
  it('(13) PAR: candidato em QUICK_RESPONSE_TEAM + marca ativa (não alocado) → só em rejected, nunca em selected', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [],
      marks: [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
    });
    expect(result.rejected).toEqual([{ workerId: 'w1', reasonCategory: 'OTHER' }]);
    expect(result.selected).toEqual([]);
    expect(result.inService).toEqual([]);
  });

  it('(14) PAR: candidato + alocado vigente (sem marca) → só em inService, nunca em selected', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'w1', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
    });
    expect(result.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('(15) PAR: alocado vigente + marcado (sem candidatura) → só em inService, nunca em rejected', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [{ workerId: 'w1', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
    });
    expect(result.inService).toEqual([{ workerId: 'w1', vacancyId: VACANCY_ID }]);
    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

/**
 * deriveServiceTeam com datas de substituição — Fase 13, DX-13.3 (P7). `substitutions` é OPCIONAL
 * (critério "sem substitutions → saída idêntica à de hoje", provado pelas 15 casos acima que
 * continuam verdes sem tocar a chave). Datas comparadas como STRING `YYYY-MM-DD`, nunca `Date`.
 */
describe('deriveServiceTeam — quem substitui num dia (DX-13.3)', () => {
  const SERVICE_ID = 'service-1';
  const OTHER_SERVICE_ID = 'service-2';
  const VACANCY_ID = 'vacancy-1';
  const TITULAR_VACANCY = 'vacancy-titular';
  const ASOF = '2026-09-28';

  it('(16) substitui no dia de hoje (date = asOf) → substituto em inService com substitutionDates, fora de selected; titular também em inService', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'titular', serviceId: SERVICE_ID, vacancyId: TITULAR_VACANCY, validFrom: '2026-01-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
      substitutions: [{ workerId: 'substituto', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: ASOF }],
    });
    expect(result.inService).toEqual([
      { workerId: 'titular', vacancyId: TITULAR_VACANCY },
      { workerId: 'substituto', vacancyId: VACANCY_ID, substitutionDates: [ASOF] },
    ]);
    expect(result.selected).toEqual([]);
  });

  it('(17) substitui numa data já passada (date = asOf − 1 como string) → substituto em Selecionado, fora de inService', () => {
    const ontem = '2026-09-27';
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [{ workerId: 'substituto', vacancyId: VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE }],
      assignments: [],
      marks: [],
      substitutions: [{ workerId: 'substituto', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: ontem }],
    });
    expect(result.inService).toEqual([]);
    expect(result.selected).toEqual([{ workerId: 'substituto', vacancyId: VACANCY_ID }]);
  });

  it('(18) duas datas futuras de quem substitui, fora de ordem → substitutionDates ordenadas, sem repetição', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [],
      marks: [],
      substitutions: [
        { workerId: 'substituto', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: '2026-10-05' },
        { workerId: 'substituto', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: '2026-09-29' },
        { workerId: 'substituto', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: '2026-10-05' },
      ],
    });
    expect(result.inService).toEqual([
      { workerId: 'substituto', vacancyId: VACANCY_ID, substitutionDates: ['2026-09-29', '2026-10-05'] },
    ]);
  });

  it('(19) substitui em OUTRO serviço → ignorada', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [],
      marks: [],
      substitutions: [{ workerId: 'substituto', serviceId: OTHER_SERVICE_ID, vacancyId: VACANCY_ID, date: ASOF }],
    });
    expect(result.inService).toEqual([]);
  });

  it('(20) quem é titular E substitui outra alocação do MESMO serviço → uma entrada com allocations e substitutionDates', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        {
          workerId: 'w1',
          serviceId: SERVICE_ID,
          vacancyId: TITULAR_VACANCY,
          validFrom: '2026-01-01',
          validTo: null,
          status: 'ACTIVE',
          allocationId: 'alloc-1',
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
        },
      ],
      marks: [],
      substitutions: [{ workerId: 'w1', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: ASOF }],
    });
    expect(result.inService).toEqual([
      {
        workerId: 'w1',
        vacancyId: TITULAR_VACANCY,
        allocations: [{ allocationId: 'alloc-1', weekday: 1, startTime: '08:00', endTime: '12:00' }],
        substitutionDates: [ASOF],
      },
    ]);
  });

  it('(21) quem substitui e tem marca de rejeição ativa → fica em inService (alocado > rejeitado), fora de rejected', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [],
      marks: [{ workerId: 'substituto', serviceId: SERVICE_ID, rejectReasonCategory: 'OTHER' }],
      substitutions: [{ workerId: 'substituto', serviceId: SERVICE_ID, vacancyId: VACANCY_ID, date: ASOF }],
    });
    expect(result.inService).toEqual([{ workerId: 'substituto', vacancyId: VACANCY_ID, substitutionDates: [ASOF] }]);
    expect(result.rejected).toEqual([]);
  });

  it('(22) allocations só aparece quando allocationId está presente na alocação do titular', () => {
    const result = deriveServiceTeam({
      serviceId: SERVICE_ID,
      liveVacancyId: VACANCY_ID,
      asOf: ASOF,
      candidacies: [],
      assignments: [
        { workerId: 'w1', serviceId: SERVICE_ID, vacancyId: TITULAR_VACANCY, validFrom: '2026-01-01', validTo: null, status: 'ACTIVE' },
      ],
      marks: [],
    });
    expect(result.inService).toEqual([{ workerId: 'w1', vacancyId: TITULAR_VACANCY }]);
    expect('allocations' in result.inService[0]).toBe(false);
    expect('substitutionDates' in result.inService[0]).toBe(false);
  });

  it('(23) sem substitutions (campo ausente) → saída idêntica à de hoje — os casos vivos da Fase 10 não mudam', () => {
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
});
