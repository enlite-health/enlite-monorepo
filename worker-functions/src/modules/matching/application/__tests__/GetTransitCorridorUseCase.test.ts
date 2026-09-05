/**
 * GetTransitCorridorUseCase.test.ts
 *
 * O que se afirma: (a) o par é re-autorizado pelo PAÍS nas duas leituras — é a
 * guarda de IDOR de um endpoint que recebe dois ids —, e (b) falta de ponta
 * vira `sem_cobertura` sem NENHUMA consulta a mais, que é o comportamento
 * fail-closed do parecer.
 */
import type { Pool } from 'pg';
import { GetTransitCorridorUseCase } from '../GetTransitCorridorUseCase';

const INPUT = { country: 'AR' as const, workerId: 'w-1', patientAddressId: 'a-1' };

/** Fila de respostas na ORDEM em que o use case consulta. */
function poolWith(...results: Array<{ rows: unknown[] }>): { pool: Pool; query: jest.Mock } {
  const query = jest.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  query.mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

const stopRow = (over: Record<string, unknown> = {}) => ({
  external_id: 's1', name: 'Parada 1', mode: 'bus', lines: ['6'], distance_meters: '120.4', ...over,
});

describe('GetTransitCorridorUseCase', () => {
  it('devolve as linhas diretas e a distância em linha reta', async () => {
    const { pool, query } = poolWith(
      { rows: [{ lat: '-34.6094', lng: '-58.3923' }] },              // prestador
      { rows: [{ lat: '-34.6037', lng: '-58.3816' }] },              // paciente
      { rows: [stopRow({ lines: ['6', '24'] })] },                   // paradas da origem
      { rows: [stopRow({ external_id: 's2', name: 'Parada 2', lines: ['6', '50'], distance_meters: 210 })] },
      { rows: [{ m: '1167.4' }] },                                   // linha reta
    );

    const r = await new GetTransitCorridorUseCase(pool).execute(INPUT);

    expect(r.outcome).toBe('ok');
    expect(r.lines).toEqual([{
      line: '6', mode: 'bus',
      originWalkMeters: 120, originStopName: 'Parada 1',
      destinationWalkMeters: 210, destinationStopName: 'Parada 2',
    }]);
    expect(r.straightLineMeters).toBe(1167);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('IDOR: o PAÍS do pedido entra no WHERE das DUAS leituras de pessoa', async () => {
    const { pool, query } = poolWith({ rows: [] }, { rows: [] });
    await new GetTransitCorridorUseCase(pool).execute({ ...INPUT, country: 'BR' });

    const [sqlWorker, paramsWorker] = query.mock.calls[0];
    const [sqlPatient, paramsPatient] = query.mock.calls[1];
    expect(sqlWorker).toContain('w.country = $2');
    expect(paramsWorker).toEqual(['w-1', 'BR']);
    expect(sqlPatient).toContain('p.country = $2');
    expect(paramsPatient).toEqual(['a-1', 'BR']);
  });

  it('ponta faltando é `sem_cobertura` e NÃO consulta parada nenhuma (fail-closed)', async () => {
    const semPrestador = poolWith({ rows: [] }, { rows: [{ lat: '-34.6', lng: '-58.4' }] });
    const r1 = await new GetTransitCorridorUseCase(semPrestador.pool).execute(INPUT);
    expect(r1).toEqual({ outcome: 'sem_cobertura', lines: [], straightLineMeters: null });
    // só as duas leituras de pessoa: nada de paradas, nada de distância
    expect(semPrestador.query).toHaveBeenCalledTimes(2);

    const semPaciente = poolWith({ rows: [{ lat: '-34.6', lng: '-58.4' }] }, { rows: [] });
    const r2 = await new GetTransitCorridorUseCase(semPaciente.pool).execute(INPUT);
    expect(r2.outcome).toBe('sem_cobertura');
    expect(semPaciente.query).toHaveBeenCalledTimes(2);
  });

  it('sem linha em comum é `sem_conexion_directa`, e a distância continua sendo dita', async () => {
    const { pool } = poolWith(
      { rows: [{ lat: '-34.61', lng: '-58.39' }] },
      { rows: [{ lat: '-34.60', lng: '-58.38' }] },
      { rows: [stopRow({ lines: ['6'] })] },
      { rows: [stopRow({ external_id: 's2', lines: ['152'] })] },
      { rows: [{ m: 900 }] },
    );
    const r = await new GetTransitCorridorUseCase(pool).execute(INPUT);
    expect(r.outcome).toBe('sem_conexion_directa');
    expect(r.straightLineMeters).toBe(900);
  });

  it('a busca de paradas é escopada por país e pelo raio de caminhada, com teto', async () => {
    const { pool, query } = poolWith(
      { rows: [{ lat: '-34.61', lng: '-58.39' }] },
      { rows: [{ lat: '-34.60', lng: '-58.38' }] },
      { rows: [] }, { rows: [] }, { rows: [{ m: 1 }] },
    );
    await new GetTransitCorridorUseCase(pool).execute(INPUT);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain('ST_DWithin');
    expect(sql).toContain('LIMIT 200');
    expect(params).toEqual(['-34.61', '-58.39', 400, 'AR']);
  });

  it('coluna numérica do pg chega como string e vira número — nunca NaN na tela', async () => {
    const { pool } = poolWith(
      { rows: [{ lat: -34.61, lng: -58.39 }] },   // já numérico
      { rows: [{ lat: '-34.60', lng: '-58.38' }] }, // string
      { rows: [stopRow({ distance_meters: '99.6' })] },
      { rows: [stopRow({ external_id: 's2', distance_meters: 40 })] },
      { rows: [{ m: '1234.7' }] },
    );
    const r = await new GetTransitCorridorUseCase(pool).execute(INPUT);
    expect(r.lines[0].originWalkMeters).toBe(100);
    expect(r.lines[0].destinationWalkMeters).toBe(40);
    expect(r.straightLineMeters).toBe(1235);
  });
});
