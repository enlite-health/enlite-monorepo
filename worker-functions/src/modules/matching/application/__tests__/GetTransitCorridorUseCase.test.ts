/**
 * GetTransitCorridorUseCase.test.ts
 *
 * O que se afirma: (a) o par é re-autorizado pelo PAÍS nas duas leituras — é a
 * guarda de IDOR de um endpoint que recebe dois ids —, e (b) ponta faltando
 * vira `sem_cobertura` SEM chamar o Google. O (b) é o mais importante: é o que
 * impede a rota de virar sonda de existência e o que garante que nenhuma
 * coordenada sai quando não há o que responder.
 */
import type { Pool } from 'pg';
import { GetTransitCorridorUseCase } from '../GetTransitCorridorUseCase';
import type { GoogleTransitDirections } from '../../infrastructure/GoogleTransitDirections';

// Formato da Routes API (o mesmo medido na fixture do domínio, em miniatura).
const rotaCrua = [{ duration: '2040s', legs: [{ duration: '2040s', steps: [
  { travelMode: 'WALK', staticDuration: '240s', distanceMeters: 320 },
  { travelMode: 'TRANSIT', staticDuration: '1560s', transitDetails: {
    transitLine: { nameShort: '8', vehicle: { type: 'BUS' } },
    stopDetails: { departureStop: { name: 'a' }, arrivalStop: { name: 'b' } },
  } },
] }] }];

const fakeDirections = (rotas: unknown[] = rotaCrua) => {
  const transit = jest.fn().mockResolvedValue(rotas);
  return { svc: { transit } as unknown as GoogleTransitDirections, transit };
};

const INPUT = { country: 'AR' as const, workerId: 'w-1', patientAddressId: 'a-1' };

/** Fila de respostas na ORDEM em que o use case consulta. */
function poolWith(...results: Array<{ rows: unknown[] }>): { pool: Pool; query: jest.Mock } {
  const query = jest.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  query.mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

describe('GetTransitCorridorUseCase', () => {
  it('devolve a rota do Google e a distância em linha reta', async () => {
    const { pool } = poolWith(
      { rows: [{ lat: '-34.6094', lng: '-58.3923' }] },   // prestador
      { rows: [{ lat: '-34.6037', lng: '-58.3816' }] },   // paciente
      { rows: [{ m: '1167.4' }] },                        // linha reta
    );
    const { svc, transit } = fakeDirections();

    const r = await new GetTransitCorridorUseCase(pool, svc).execute(INPUT);

    expect(r.outcome).toBe('ok');
    expect(r.routes[0]).toMatchObject({ totalMinutes: 34, transfers: 0, lines: ['8'] });
    expect(r.straightLineMeters).toBe(1167);
    // as coordenadas chegam ao Google como NÚMERO, não string do pg
    expect(transit).toHaveBeenCalledWith({ lat: -34.6094, lng: -58.3923 }, { lat: -34.6037, lng: -58.3816 });
  });

  it('IDOR: o PAÍS do pedido entra no WHERE das DUAS leituras de pessoa', async () => {
    const { pool, query } = poolWith({ rows: [] }, { rows: [] });
    await new GetTransitCorridorUseCase(pool, fakeDirections().svc).execute({ ...INPUT, country: 'BR' });

    const [sqlWorker, paramsWorker] = query.mock.calls[0];
    const [sqlPatient, paramsPatient] = query.mock.calls[1];
    expect(sqlWorker).toContain('w.country = $2');
    expect(paramsWorker).toEqual(['w-1', 'BR']);
    expect(sqlPatient).toContain('p.country = $2');
    expect(paramsPatient).toEqual(['a-1', 'BR']);
  });

  it('🔒 ponta faltando é `sem_cobertura` e NÃO chama o Google — nada sai do perímetro', async () => {
    const semPrestador = poolWith({ rows: [] }, { rows: [{ lat: '-34.6', lng: '-58.4' }] });
    const d1 = fakeDirections();
    const r1 = await new GetTransitCorridorUseCase(semPrestador.pool, d1.svc).execute(INPUT);
    expect(r1).toEqual({ outcome: 'sem_cobertura', routes: [], straightLineMeters: null });
    expect(d1.transit).not.toHaveBeenCalled();
    // só as duas leituras de pessoa: nem a distância foi calculada
    expect(semPrestador.query).toHaveBeenCalledTimes(2);

    const semPaciente = poolWith({ rows: [{ lat: '-34.6', lng: '-58.4' }] }, { rows: [] });
    const d2 = fakeDirections();
    expect((await new GetTransitCorridorUseCase(semPaciente.pool, d2.svc).execute(INPUT)).outcome).toBe('sem_cobertura');
    expect(d2.transit).not.toHaveBeenCalled();
  });

  it('Google sem trajeto vira `sem_ruta`, e a distância continua sendo dita', async () => {
    const { pool } = poolWith(
      { rows: [{ lat: '-34.61', lng: '-58.39' }] },
      { rows: [{ lat: '-34.60', lng: '-58.38' }] },
      { rows: [{ m: 900 }] },
    );
    const r = await new GetTransitCorridorUseCase(pool, fakeDirections([]).svc).execute(INPUT);
    expect(r.outcome).toBe('sem_ruta');
    expect(r.straightLineMeters).toBe(900);
  });

  it('sem injetar o serviço, o padrão é o real — e num ambiente sem chave ele não chama nada', async () => {
    // Cobre o construtor default. Também é a garantia de que um chamador que
    // esqueça de injetar não vira um vazamento: sem `GOOGLE_*_API_KEY` o
    // serviço real é inerte (ver GoogleTransitDirections: o interruptor).
    delete process.env.GOOGLE_DIRECTIONS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    const { pool } = poolWith(
      { rows: [{ lat: '-34.61', lng: '-58.39' }] },
      { rows: [{ lat: '-34.60', lng: '-58.38' }] },
      { rows: [{ m: 500 }] },
    );
    const r = await new GetTransitCorridorUseCase(pool).execute(INPUT);
    expect(r.outcome).toBe('sem_ruta');
  });

  it('coluna numérica do pg chega como string e vira número — nunca NaN indo para o Google', async () => {
    const { pool } = poolWith(
      { rows: [{ lat: -34.61, lng: -58.39 }] },      // já numérico
      { rows: [{ lat: '-34.60', lng: '-58.38' }] },  // string
      { rows: [{ m: '1234.7' }] },
    );
    const { svc, transit } = fakeDirections();
    const r = await new GetTransitCorridorUseCase(pool, svc).execute(INPUT);
    expect(r.straightLineMeters).toBe(1235);
    expect(transit).toHaveBeenCalledWith({ lat: -34.61, lng: -58.39 }, { lat: -34.6, lng: -58.38 });
  });
});
