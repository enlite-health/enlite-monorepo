import { GetCostOverviewUseCase, InvalidMonthError } from '../GetCostOverviewUseCase';
import { BillingReadError, SyncRateLimitedError, type BillingData } from '../../domain/types';
import type { BillingReader } from '../ports';

function data(over: Partial<BillingData> = {}): BillingData {
  return {
    currency: 'BRL', dataUntil: '2026-10-11T06:00:00.000Z', dailyTotals: [], months: [], byService: [], byResource: [],
    bySector: [], byAiCaller: [], dailyByService: [], dailyByResource: [], ...over,
  };
}

const days = (prefix: string, from: number, to: number, value: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ day: `${prefix}-${String(from + i).padStart(2, '0')}`, value }));

function setup(d: BillingData, start = new Date('2026-10-11T12:00:00Z')) {
  let t = start.getTime();
  const reader: BillingReader = { read: jest.fn(async () => d) };
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
    const reader: BillingReader = { read: async () => { throw new BillingReadError('bytes_limit'); } };
    await expect(new GetCostOverviewUseCase(reader).execute()).rejects.toMatchObject({ code: 'bytes_limit' });
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
    const uc = new GetCostOverviewUseCase({ read }, () => new Date('2026-10-11T12:00:00Z'));
    await expect(uc.execute()).rejects.toMatchObject({ code: 'billing_query_failed' });
    await expect(uc.execute()).rejects.toBeInstanceOf(SyncRateLimitedError);
  });
});
