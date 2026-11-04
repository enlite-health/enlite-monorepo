import { GetCostOverviewUseCase, InvalidMonthError } from '../GetCostOverviewUseCase';
import { BillingReadError, SyncRateLimitedError, type AiCallerCost, type AnomalyDetailRow, type BillingData, type BillingWindow, type DailyCostPoint, type DetailRange } from '../../domain/types';
import type { BillingReader } from '../ports';

function data(over: Partial<BillingData> = {}): BillingData {
  return {
    currency: 'BRL', dataUntil: '2026-10-11T06:00:00.000Z', dailyTotals: [], months: [], byService: [], byResource: [],
    bySector: [], byAiCaller: [], byProject: [], availableMonths: [], dailyByService: [], dailyByResource: [], ...over,
  };
}

const days = (prefix: string, from: number, to: number, value: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ day: `${prefix}-${String(from + i).padStart(2, '0')}`, value }));

function setup(d: BillingData, start = new Date('2026-10-11T12:00:00Z')) {
  let t = start.getTime();
  const reader: jest.Mocked<BillingReader> = { read: jest.fn(async (_w: BillingWindow) => d), readAnomalyDetail: jest.fn(async (_r: DetailRange, _s: string[]): Promise<AnomalyDetailRow[]> => []) };
  const uc = new GetCostOverviewUseCase(reader, () => new Date(t));
  return { uc, reader, advance: (ms: number) => { t += ms; } };
}

describe('GetCostOverviewUseCase — cálculo', () => {
  it('total do mês, mês anterior até o mesmo dia e fechado, previsão pelos dias completos', async () => {
    // set: 30 dias a 3 = 90 (até o dia 11 = 33); out: dias 1..11 a 10 (o dia 11 é parcial, dataUntil = 11/10)
    const { uc } = setup(data({ dailyTotals: [...days('2026-09', 1, 30, 3), ...days('2026-10', 1, 11, 10)] }));
    const o = await uc.execute();
    expect(o.month).toBe('2026-10');
    expect(o.monthTotal).toBe(110);
    expect(o.prevMonthToDate).toBe(33);
    expect(o.prevMonthTotal).toBe(90);
    // completos = dias 1..10 (100) -> 100/10 * 31
    expect(o.forecast).toEqual({ value: 310, basis: 'linear', daysCounted: 10 });
    expect(o.anomalies.status).toBe('insufficient_history');
  });

  it('sem linhas do mês anterior -> prevMonthToDate e prevMonthTotal nulos; sem dado -> estado vazio', async () => {
    const o = await setup(data({ currency: null, dataUntil: null })).uc.execute();
    expect(o).toMatchObject({ monthTotal: 0, prevMonthToDate: null, prevMonthTotal: null, currency: null, dataUntil: null });
    expect(o.forecast.value).toBeNull();
  });

  it('anomalia: série diária vinda do leitor passa por detectAnomalies', async () => {
    const hist = days('2026-10', 3, 9, 10).map((d) => ({ kind: 'service' as const, name: 'svc-a', ...d }));
    const latest = { kind: 'service' as const, name: 'svc-a', day: '2026-10-10', value: 25 };
    const o = await setup(data({ dailyByService: [...hist, latest] })).uc.execute();
    expect(o.anomalies.status).toBe('ok');
    expect(o.anomalies.items).toHaveLength(1);
    expect(o.anomalies.items[0]).toMatchObject({ name: 'svc-a', dayValue: 25, median7: 10 });
  });

  it('mês inválido -> InvalidMonthError e o leitor não roda', async () => {
    const { uc, reader } = setup(data());
    await expect(uc.execute('2026-13')).rejects.toBeInstanceOf(InvalidMonthError);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('erro do leitor passa adiante com o código', async () => {
    const reader: BillingReader = { read: async () => { throw new BillingReadError('bytes_limit'); }, readAnomalyDetail: async () => [] };
    await expect(new GetCostOverviewUseCase(reader).execute()).rejects.toMatchObject({ code: 'bytes_limit' });
  });
});

/** 7 dias de histórico (3..9/10) a 10 + o dia 10/10 (o último completo, dataUntil = 11/10) com `latest`. */
const svc = (kind: DailyCostPoint['kind'], name: string, latest: number, hist = 10): DailyCostPoint[] => [
  ...days('2026-10', 3, 9, hist).map((d) => ({ kind, name, ...d })),
  { kind, name, day: '2026-10-10', value: latest },
];

describe('GetCostOverviewUseCase — delta do contrato (CA-15)', () => {
  it('day, rule, series (14 pontos, zero-fill) e detail só no serviço não-novo; recurso e "novo" sem detail', async () => {
    const detailRows = [
      { day: '2026-10-09', service: 'svc-a', resource: 'r1', value: 4 }, { day: '2026-10-10', service: 'svc-a', resource: 'r1', value: 19 },
    ];
    const { uc, reader } = setup(data({
      dailyByService: [...svc('service', 'svc-a', 25), ...svc('service', 'svc-ok', 10), { kind: 'service', name: 'svc-new', day: '2026-10-10', value: 8 }],
      dailyByResource: svc('resource', 'res-x', 30),
    }));
    reader.readAnomalyDetail.mockResolvedValueOnce(detailRows);
    const a = (await uc.execute()).anomalies;

    expect(a.status).toBe('ok');
    expect(a.day).toBe('2026-10-10');
    expect(a.rule).toEqual({ factor: 2, minDelta: 5, windowDays: 7 });
    expect(a.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['resource:res-x', 'service:svc-a', 'service:svc-new']);
    for (const i of a.items) {
      expect(i.series).toHaveLength(14);
      expect(i.series[13]).toEqual({ day: '2026-10-10', value: i.dayValue });
    }
    const sa = a.items.find((i) => i.name === 'svc-a')!;
    // 14 dias terminando em 10/10 = 27/09..10/10; histórico só de 03/10 em diante -> 6 zeros na frente
    expect(sa.series.map((p) => p.value)).toEqual([0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 10, 25]);

    expect(reader.readAnomalyDetail).toHaveBeenCalledTimes(1);
    // janela: min(dia 1 do mês, dia-7) até hoje inclusive (dailyToExclusive = 12/10); só o serviço anômalo NÃO-novo
    expect(reader.readAnomalyDetail).toHaveBeenCalledWith({ from: '2026-10-01', toExclusive: '2026-10-12' }, ['svc-a']);
    expect(sa.detail?.resources).toEqual([{ resource: 'r1', dayValue: 19, median7: 0, monthTotal: 23 }]);
    expect(sa.detail?.monthSeries).toHaveLength(10);
    expect(a.items.filter((i) => i.detail !== undefined).map((i) => i.name)).toEqual(['svc-a']);
  });

  it('no máx. 5 serviços com detalhe, os de maior impacto; o 6º anômalo fica sem detail', async () => {
    const names = ['s1', 's2', 's3', 's4', 's5', 's6'];
    // impacto = latest − 10: s1 = 6 … s6 = 1 não bastam (mínimo 5): usa latest 31..26 (impacto 21..16) e s6 o menor
    const pts = names.flatMap((n, i) => svc('service', n, 31 - i));
    const { uc, reader } = setup(data({ dailyByService: pts }));
    const a = (await uc.execute()).anomalies;
    expect(a.items).toHaveLength(6);
    expect(reader.readAnomalyDetail).toHaveBeenCalledWith(expect.anything(), ['s1', 's2', 's3', 's4', 's5']);
    expect(a.items.filter((i) => i.detail).map((i) => i.name)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(a.items[5].detail).toBeUndefined();
  });

  it('dia calmo e histórico insuficiente: nenhuma chamada a readAnomalyDetail', async () => {
    const calm = setup(data({ dailyByService: svc('service', 'svc-a', 11) }));
    const c = (await calm.uc.execute()).anomalies;
    expect(c).toMatchObject({ status: 'ok', day: '2026-10-10', items: [] });
    expect(calm.reader.readAnomalyDetail).not.toHaveBeenCalled();

    const few = setup(data({ dailyByService: svc('service', 'svc-a', 99).slice(2) }));
    expect((await few.uc.execute()).anomalies).toMatchObject({ status: 'insufficient_history', day: null, items: [] });
    expect(few.reader.readAnomalyDetail).not.toHaveBeenCalled();
  });

  it('só anomalia de RECURSO ou só item "novo": sem consulta de detalhe', async () => {
    const { uc, reader } = setup(data({
      dailyByService: [...svc('service', 'svc-ok', 10), { kind: 'service', name: 'svc-new', day: '2026-10-10', value: 9 }],
      dailyByResource: svc('resource', 'res-x', 30),
    }));
    const a = (await uc.execute()).anomalies;
    expect(a.items).toHaveLength(2);
    expect(reader.readAnomalyDetail).not.toHaveBeenCalled();
  });

  it('falha da consulta de detalhe propaga como o erro do leitor (sem detalhe silencioso)', async () => {
    const { uc, reader } = setup(data({ dailyByService: svc('service', 'svc-a', 25) }));
    reader.readAnomalyDetail.mockRejectedValueOnce(new BillingReadError('bytes_limit'));
    await expect(uc.execute()).rejects.toMatchObject({ code: 'bytes_limit' });
  });
});

describe('GetCostOverviewUseCase — IA estimada só sem billing (CA-16, DF-15)', () => {
  const row = (caller: string, source: AiCallerCost['source'], total: number | null, funcao = 'f'): AiCallerCost => ({ caller, funcao, total, currency: 'USD', source });

  it('chamador com linha billing + estimated -> só a billing; só estimated (sol) -> mantém; unattributed intacta', async () => {
    const byAiCaller = [
      row('worker-functions', 'billing', 5), row('worker-functions', 'estimated', 3.1),
      row('sol', 'estimated', 0.4), row('__none__', 'unattributed', 1, '__none__'),
      row('triage-service', 'billing', 2, 'luz'), row('triage-service', 'estimated', 1.9, 'outra-funcao'),
    ];
    const o = await setup(data({ byAiCaller })).uc.execute();
    expect(o.byAiCaller).toEqual([
      row('worker-functions', 'billing', 5), row('sol', 'estimated', 0.4), row('__none__', 'unattributed', 1, '__none__'), row('triage-service', 'billing', 2, 'luz'),
    ]);
  });
});

describe('GetCostOverviewUseCase — mês e projeto (CA-20, DF-20/DF-21)', () => {
  it('byProject e availableMonths do leitor chegam ao payload sem alteração', async () => {
    const byProject = [{ project: 'enlite-prd', total: 75 }, { project: 'enlite-stg', total: 24 }, { project: '__none__', total: 1 }];
    const availableMonths = ['2026-10', '2026-09'];
    const o = await setup(data({ byProject, availableMonths })).uc.execute();
    expect(o.byProject).toEqual(byProject);
    expect(o.availableMonths).toEqual(availableMonths);
  });

  it('mês escolhido vira UMA leitura com a janela desse mês; hoje continua sendo o âncora de availableMonths', async () => {
    const { uc, reader } = setup(data());
    await uc.execute('2026-09');
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.read.mock.calls[0][0]).toMatchObject({ month: '2026-09', monthStart: '2026-09-01', monthEndExclusive: '2026-10-01', availableFrom: '2025-10-01', availableToExclusive: '2026-10-12' });
  });
});

describe('GetCostOverviewUseCase — mês fechado (DF-22)', () => {
  // hoje = 11/10; escolhido = setembro (fechado). Agosto 31 dias a 2, setembro 30 dias a 3; dataUntil global = 11/10.
  const fechado = () => data({ dataUntil: '2026-10-11T06:00:00.000Z', dailyTotals: [...days('2026-08', 1, 31, 2), ...days('2026-09', 1, 30, 3)] });

  it('anomalies.status = not_applicable e readAnomalyDetail NÃO roda', async () => {
    const hist = days('2026-09', 1, 30, 10).map((d) => ({ kind: 'service' as const, name: 'svc-a', ...d }));
    const { uc, reader } = setup(data({ ...fechado(), dailyByService: [...hist, { kind: 'service', name: 'svc-a', day: '2026-09-30', value: 99 }] }));
    const o = await uc.execute('2026-09');
    expect(o.anomalies).toMatchObject({ status: 'not_applicable', day: null, items: [] });
    expect(reader.readAnomalyDetail).not.toHaveBeenCalled();
  });

  it('prevMonthToDate = mês anterior INTEIRO (31 dias, não 30) e forecast.value = null', async () => {
    const o = await setup(fechado()).uc.execute('2026-09');
    expect(o.monthTotal).toBe(90);
    expect(o.prevMonthTotal).toBe(62);
    expect(o.prevMonthToDate).toBe(62);
    expect(o.forecast.value).toBeNull();
  });

  it('dataUntil é o do leitor (global), sem recorte pela janela do mês', async () => {
    const o = await setup(fechado()).uc.execute('2026-09');
    expect(o.dataUntil).toBe('2026-10-11T06:00:00.000Z');
  });

  it('a janela diária pedida ao leitor termina no último dia do mês fechado', async () => {
    const { uc, reader } = setup(fechado());
    await uc.execute('2026-09');
    expect(reader.read.mock.calls[0][0]).toMatchObject({ dailyFrom: '2026-09-16', dailyToExclusive: '2026-10-01' });
  });

  it('mês corrente continua calculando anomalia (status != not_applicable)', async () => {
    const o = await setup(data()).uc.execute('2026-10');
    expect(o.anomalies.status).not.toBe('not_applicable');
  });
});

describe('GetCostOverviewUseCase — limite de 1 sync a cada 10 s (CA-5, parte 2)', () => {
  it('segunda chamada em < 10 s -> SyncRateLimitedError com retryAfterSeconds; depois de 10 s passa', async () => {
    const { uc, reader, advance } = setup(data());
    await uc.execute();
    advance(3_000);
    const err = await uc.execute().catch((e) => e);
    expect(err).toBeInstanceOf(SyncRateLimitedError);
    expect(err.retryAfterSeconds).toBe(7);
    expect(reader.read).toHaveBeenCalledTimes(1);
    advance(7_000);
    await uc.execute();
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it('a tentativa que falhou também conta (protege o custo da consulta)', async () => {
    const read = jest.fn().mockRejectedValueOnce(new BillingReadError('billing_query_failed')).mockResolvedValue(data());
    const uc = new GetCostOverviewUseCase({ read, readAnomalyDetail: async () => [] }, () => new Date('2026-10-11T12:00:00Z'));
    await expect(uc.execute()).rejects.toMatchObject({ code: 'billing_query_failed' });
    await expect(uc.execute()).rejects.toBeInstanceOf(SyncRateLimitedError);
  });
});
