import { ItineraryDailyRunHealthService } from '../ItineraryDailyRunHealthService';

/** 09:00 UTC = 06:00 AR/BR (depois do prazo? não: o prazo é 08:00 LOCAL); 11:30 UTC = 08:30 local. */
const ANTES_DO_PRAZO = new Date('2026-11-02T10:30:00Z'); // 07:30 local
const DEPOIS_DO_PRAZO = new Date('2026-11-02T11:30:00Z'); // 08:30 local

describe('ItineraryDailyRunHealthService (spec 069 F4, alarme "não rodou")', () => {
  it('antes das 08:00 locais não cobra nada e NEM consulta o banco', async () => {
    const query = jest.fn();
    expect(await new ItineraryDailyRunHealthService({ query } as never).getHealth(ANTES_DO_PRAZO)).toEqual({ missing: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('depois das 08:00 locais, país SEM rodada terminada do dia (data local) entra em missing; o que terminou fica de fora', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ country: 'AR', operation_date: '2026-11-02' }] });
    const h = await new ItineraryDailyRunHealthService({ query } as never).getHealth(DEPOIS_DO_PRAZO);
    expect(h.missing).toEqual([{ country: 'BR', operationDate: '2026-11-02' }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('finished_at IS NOT NULL');
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(params).toEqual([['2026-11-02', '2026-11-02']]);
  });

  it('controle positivo: tudo terminado → missing vazio; nada terminado → os dois países', async () => {
    const todos = jest.fn().mockResolvedValue({ rows: [{ country: 'AR', operation_date: '2026-11-02' }, { country: 'BR', operation_date: '2026-11-02' }] });
    expect((await new ItineraryDailyRunHealthService({ query: todos } as never).getHealth(DEPOIS_DO_PRAZO)).missing).toEqual([]);
    const nenhum = jest.fn().mockResolvedValue({ rows: [] });
    expect((await new ItineraryDailyRunHealthService({ query: nenhum } as never).getHealth(DEPOIS_DO_PRAZO)).missing.map((m) => m.country)).toEqual(['AR', 'BR']);
  });

  it('usa a data LOCAL do país: 02:30Z já passou do prazo? não (23:30 do dia anterior) — e fuso distinto exige a data do próprio país', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    // Tokyo (+9) às 23:30Z de 02/11 = 08:30 de 03/11 local → data 2026-11-03 (a UTC diz 02/11); Los Angeles (-7/-8) = 15:30 de 02/11 → data 2026-11-02
    const svc = new ItineraryDailyRunHealthService({ query } as never, { JP: 'Asia/Tokyo', US: 'America/Los_Angeles' });
    const h = await svc.getHealth(new Date('2026-11-02T23:30:00Z'));
    expect(h.missing).toEqual([
      { country: 'JP', operationDate: '2026-11-03' },
      { country: 'US', operationDate: '2026-11-02' },
    ]);
  });
});
