import { GetArmedCasesUseCase } from '../GetArmedCasesUseCase';

interface Row {
  providers_needed: string | null;
  schedule: unknown;
  sel_total: number;
  sel_with_role: number;
  sel_titular: number;
  sel_substituto: number;
}

function row(partial: Partial<Row>): Row {
  return {
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
    });
  });
});
