import { Pool } from 'pg';
import { AnaCareMirrorHealthService } from '../AnaCareMirrorHealthService';

/**
 * Unit do que NÃO é SQL neste serviço: os defaults do método e o mapeamento da
 * linha de retorno. O corpo da query (o relógio em si) só é provável contra
 * banco real — ver `tests/e2e/anacare-mirror-health.e2e.test.ts`.
 *
 * Estes ramos existiam sem execução em teste nenhum: o e2e sempre passa os dois
 * parâmetros explicitamente, e o unit do InternalController também. Foi o gate
 * de revisão que apontou o buraco.
 */
describe('AnaCareMirrorHealthService', () => {
  function makeService(rows: unknown[]) {
    const query = jest.fn().mockResolvedValue({ rows });
    const pool = { query } as unknown as Pool;
    return { service: new AnaCareMirrorHealthService(pool), query };
  }

  it('usa 2h de limite e 168h de janela quando chamado sem argumentos', async () => {
    const { service, query } = makeService([
      { stuck_recent: 0, oldest_stuck_since: null, chronic_total: 0 },
    ]);

    await service.getMirrorHealth();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([2, 168]);
  });

  it('repassa limite e janela explícitos para a query', async () => {
    const { service, query } = makeService([
      { stuck_recent: 0, oldest_stuck_since: null, chronic_total: 0 },
    ]);

    await service.getMirrorHealth(6, 72);

    expect(query.mock.calls[0][1]).toEqual([6, 72]);
  });

  it('mapeia a linha de retorno e marca stuck quando há preso recente', async () => {
    const cincoHorasAtras = new Date(Date.now() - 5 * 3_600_000);
    const { service } = makeService([
      { stuck_recent: 3, oldest_stuck_since: cincoHorasAtras, chronic_total: 7 },
    ]);

    const result = await service.getMirrorHealth();

    expect(result.stuckRecent).toBe(3);
    expect(result.chronicTotal).toBe(7);
    expect(result.oldestStuckAgeHours).toBeCloseTo(5, 1);
    expect(result.stuck).toBe(true);
  });

  it('sem preso recente, não marca stuck mesmo com backlog crônico', async () => {
    const { service } = makeService([
      { stuck_recent: 0, oldest_stuck_since: null, chronic_total: 14 },
    ]);

    const result = await service.getMirrorHealth();

    expect(result.stuck).toBe(false);
    expect(result.oldestStuckAgeHours).toBe(0);
    expect(result.chronicTotal).toBe(14);
  });

  it('resposta sem linhas degrada para zeros em vez de estourar', async () => {
    const { service } = makeService([]);

    const result = await service.getMirrorHealth();

    expect(result).toEqual({
      stuckRecent: 0,
      oldestStuckAgeHours: 0,
      chronicTotal: 0,
      stuck: false,
    });
  });
});
