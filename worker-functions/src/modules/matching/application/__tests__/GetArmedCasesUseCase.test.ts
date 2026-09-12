import { GetArmedCasesUseCase } from '../GetArmedCasesUseCase';

interface Row {
  id: string;
  providers_needed: string | null;
  schedule: unknown;
  sel_total: number;
  sel_with_role: number;
  sel_titular: number;
  sel_substituto: number;
}

function row(partial: Partial<Row>): Row {
  return {
    id: 'jp-1',
    providers_needed: '2',
    schedule: null,
    sel_total: 0,
    sel_with_role: 0,
    sel_titular: 0,
    sel_substituto: 0,
    ...partial,
  };
}

function mockDb(rows: Row[]): { query: jest.Mock } {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('GetArmedCasesUseCase', () => {
  it('agrega os quatro buckets a partir das linhas por caso', async () => {
    const db = mockDb([
      // ARMADA: 2 titulares, 10 substitutos
      row({ providers_needed: '2', sel_total: 12, sel_with_role: 12, sel_titular: 2, sel_substituto: 10 }),
      // POR_ARMAR: classificável (tem papel) mas falta substituto
      row({ providers_needed: '2', sel_total: 3, sel_with_role: 3, sel_titular: 2, sel_substituto: 1 }),
      // POR_ARMAR: numérico sem nenhum selecionado
      row({ providers_needed: '1', sel_total: 0, sel_with_role: 0 }),
      // PENDENTE_CLASSIFICACAO: selecionados sem papel
      row({ providers_needed: '3', sel_total: 4, sel_with_role: 0 }),
      // SEM_CONFIG: providers_needed não-numérico
      row({ providers_needed: 'a confirmar', sel_total: 5, sel_with_role: 5, sel_titular: 5 }),
      // SEM_CONFIG: null
      row({ providers_needed: null }),
    ]);

    const result = await new GetArmedCasesUseCase(db as never).execute();

    expect(result.armados).toBe(1);
    expect(result.porArmar).toBe(2);
    expect(result.pendenteClasificacao).toBe(1);
    expect(result.semConfig).toBe(2);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('soma horas do JSONB e reporta cobertura; horasAPreencher só de POR_ARMAR', async () => {
    const scheduleArmada = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]; // 4h
    const schedulePorArmar = [{ dayOfWeek: 5, startTime: '22:00', endTime: '06:00' }]; // 8h overnight

    const db = mockDb([
      // ARMADA com schedule 4h
      row({ providers_needed: '1', sel_total: 11, sel_with_role: 11, sel_titular: 1, sel_substituto: 10, schedule: scheduleArmada }),
      // POR_ARMAR com schedule 8h
      row({ providers_needed: '2', sel_total: 2, sel_with_role: 2, sel_titular: 1, sel_substituto: 1, schedule: schedulePorArmar }),
      // POR_ARMAR SEM schedule
      row({ providers_needed: '1', sel_total: 0, sel_with_role: 0, schedule: null }),
    ]);

    const result = await new GetArmedCasesUseCase(db as never).execute();

    expect(result.horasTotais).toBeCloseTo(12, 5); // 4 + 8
    expect(result.horasAPreencher).toBeCloseTo(8, 5); // só o POR_ARMAR com schedule
    expect(result.coberturaConSchedule).toBe(2);
    expect(result.coberturaSinSchedule).toBe(1);
  });

  it('zera tudo quando não há casos', async () => {
    const result = await new GetArmedCasesUseCase(mockDb([]) as never).execute();
    expect(result).toEqual({
      armados: 0,
      porArmar: 0,
      semConfig: 0,
      pendenteClasificacao: 0,
      horasTotais: 0,
      horasAPreencher: 0,
      coberturaConSchedule: 0,
      coberturaSinSchedule: 0,
      respostaRapida: { num: 0, den: 0, excluidos: 0 },
      armadaCaseIds: [],
    });
  });

  it('% RR: numerador conta caso medível com substitutos suficientes; ids ARMADA saem na lista', async () => {
    const rows = [
      // ARMADA (1 titular exigido, 10 substitutos) → num E armadaCaseIds
      row({ id: 'jp-armada', providers_needed: '1', sel_total: 11, sel_with_role: 11, sel_titular: 1, sel_substituto: 10 }),
      // POR_ARMAR com 10 substitutos mas sem titular → conta no num (RR pronto, titular não)
      row({ id: 'jp-rr', providers_needed: '1', sel_total: 10, sel_with_role: 10, sel_titular: 0, sel_substituto: 10 }),
      // POR_ARMAR sem substitutos → só denominador
      row({ id: 'jp-vazio', providers_needed: '1', sel_total: 1, sel_with_role: 1, sel_titular: 1, sel_substituto: 0 }),
      // PENDENTE (sem papel) e SEM_CONFIG → excluidos, nunca no denominador
      row({ id: 'jp-pendente', providers_needed: '1', sel_total: 3, sel_with_role: 0 }),
      row({ id: 'jp-sem-config', providers_needed: null }),
    ];
    const result = await new GetArmedCasesUseCase(mockDb(rows) as never).execute();

    expect(result.respostaRapida).toEqual({ num: 2, den: 3, excluidos: 2 });
    expect(result.armadaCaseIds).toEqual(['jp-armada']);
  });

  /**
   * PR-9 (`lex` #9, FR-732/L9-3): a consulta de casos ARMADOS toca `job_postings`
   * e alimenta `bigNumbers.equiposArmados`/`equiposPorArmar` E os `armadaCaseIds`
   * que recortam o card "Em Busca" — ou seja, é dado de país como qualquer outro.
   *
   * Esta é a ÚNICA trava sobre o predicado desta query: o teste de forma do
   * dashboard (`GetManagementDashboardUseCase.test.ts`) percorre as 12 consultas
   * do `Promise.all` por índice, e a de armados roda SERIALIZADA antes dele, fora
   * daquele mapa. Medido no gate (12/09): sem este teste, apagar
   * `countryPredicateSql('jp', 1)` de `GetArmedCasesUseCase` deixava a suíte
   * inteira verde (2249/2249) — guarda de regressão que não morre não é guarda.
   *
   * Sabotagem que derruba este teste: remover o predicado da query, ou parar de
   * repassar `countries` ao parâmetro $1.
   */
  it('🔒 país vira predicado explícito na query de armados, e o escopo pedido chega em $1', async () => {
    const db = mockDb([]);
    await new GetArmedCasesUseCase(db as never).execute(['AR']);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('jp.country = ANY($1::bpchar[])');
    expect(params).toEqual([['AR']]);
  });
});
