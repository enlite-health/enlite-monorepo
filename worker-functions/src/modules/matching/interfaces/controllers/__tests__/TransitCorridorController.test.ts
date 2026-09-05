/**
 * TransitCorridorController.test.ts
 *
 * O teste central deste arquivo é o da TRILHA, e ele é NEGATIVO: existe para
 * ficar vermelho se alguém acrescentar duração, distância, parada, coordenada
 * ou geohash à linha de log. A razão não é zelo — `(prestador, paciente, 37min)`
 * repetido sobre N prestadores é TRILATERAÇÃO: sem uma única coordenada no log,
 * N linhas devolvem o domicílio do paciente com precisão crescente.
 *
 * É o espelho do teste que já protege o `respondMapPoints`, e a regra é a
 * mesma do parecer: "mapa = geohash sem id; rota = id sem geohash".
 */
import { Request, Response } from 'express';

const mockExecute = jest.fn();
jest.mock('../../../application/GetTransitCorridorUseCase', () => ({
  GetTransitCorridorUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
}));

const mockInfo = jest.fn();
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: { info: (...a: unknown[]) => mockInfo(...a), child: () => ({ info: jest.fn() }) },
  reportError: (...a: unknown[]) => mockReportError(...a),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { TransitCorridorController } from '../TransitCorridorController';

const WORKER = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '22222222-2222-4222-8222-222222222222';
const BODY = { country: 'AR', workerId: WORKER, patientAddressId: ADDRESS };

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const req = (body: unknown, uid = 'staff-1'): Request =>
  ({ body, user: { uid } } as unknown as Request);

const OK_RESULT = {
  outcome: 'ok' as const,
  straightLineMeters: 1167,
  lines: [{
    line: '6', mode: 'bus',
    originWalkMeters: 120, originStopName: '40 ENTRE RIOS AV.',
    destinationWalkMeters: 210, destinationStopName: '930 CORRIENTES AVE',
  }],
};

describe('TransitCorridorController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devolve o corredor em QUADRAS — a unidade em que a operação fala', async () => {
    mockExecute.mockResolvedValue(OK_RESULT);
    const res = fakeRes();
    await new TransitCorridorController().getCorridor(req(BODY), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        outcome: 'ok',
        straightLineMeters: 1167,
        straightLineBlocks: 12,
        lines: [{
          line: '6', mode: 'bus',
          originBlocks: 1, originStopName: '40 ENTRE RIOS AV.',
          destinationBlocks: 2, destinationStopName: '930 CORRIENTES AVE',
        }],
      },
    });
  });

  it('🔒 A TRILHA leva ids e o desfecho — e NADA de geografia, duração ou distância', async () => {
    mockExecute.mockResolvedValue(OK_RESULT);
    await new TransitCorridorController().getCorridor(req(BODY), fakeRes());

    expect(mockInfo).toHaveBeenCalledTimes(1);
    const linha = mockInfo.mock.calls[0][0] as Record<string, unknown>;

    expect(linha).toEqual({
      msg: 'map.corridor.read',
      uid: 'staff-1',
      country: 'AR',
      action: 'transit_corridor',
      workerId: WORKER,
      patientAddressId: ADDRESS,
      outcome: 'ok',
    });

    // As proibições, uma a uma — este bloco é o que fica vermelho se alguém
    // "melhorar" a observabilidade acrescentando o tempo do trajeto.
    for (const proibido of ['lat', 'lng', 'geohash', 'geohash5', 'center', 'stopId', 'stops',
      'durationMinutes', 'distanceKm', 'straightLineMeters', 'lines', 'transfers']) {
      expect(Object.keys(linha)).not.toContain(proibido);
    }
    const serializado = JSON.stringify(linha);
    expect(serializado).not.toContain('ENTRE RIOS');
    expect(serializado).not.toContain('1167');
    expect(serializado).not.toContain('120');
  });

  it('a trilha registra o desfecho de recusa também — auditoria não é só do caminho feliz', async () => {
    mockExecute.mockResolvedValue({ outcome: 'sem_cobertura', lines: [], straightLineMeters: null });
    const res = fakeRes();
    await new TransitCorridorController().getCorridor(req(BODY), res);
    expect((mockInfo.mock.calls[0][0] as Record<string, unknown>).outcome).toBe('sem_cobertura');
    expect((res.body as { data: { straightLineBlocks: number | null } }).data.straightLineBlocks).toBeNull();
  });

  it('UM par por chamada: corpo com lista, id inválido ou chave a mais é 400', async () => {
    const c = new TransitCorridorController();

    const comLista = fakeRes();
    await c.getCorridor(req({ country: 'AR', pairs: [BODY] }), comLista);
    expect(comLista.statusCode).toBe(400);

    const chaveAMais = fakeRes();
    await c.getCorridor(req({ ...BODY, limit: 500 }), chaveAMais);
    expect(chaveAMais.statusCode).toBe(400);

    const idRuim = fakeRes();
    await c.getCorridor(req({ ...BODY, workerId: 'nao-e-uuid' }), idRuim);
    expect(idRuim.statusCode).toBe(400);

    const semPais = fakeRes();
    await c.getCorridor(req({ workerId: WORKER, patientAddressId: ADDRESS }), semPais);
    expect(semPais.statusCode).toBe(400);

    // corpo inválido não vira leitura nem linha de trilha
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('corpo ausente é 400, não um estouro', async () => {
    const res = fakeRes();
    await new TransitCorridorController().getCorridor({ user: { uid: 'x' } } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
  });

  it('falha interna vira 500 genérico — e só a ORIGEM vai para o log de erro', async () => {
    mockExecute.mockRejectedValue(new Error('relation "transit_stops" does not exist'));
    const res = fakeRes();
    await new TransitCorridorController().getCorridor(req(BODY), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to compute transit corridor' });
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'TransitCorridorController:getCorridor' });
    // nem os ids do par vazam pelo caminho de erro
    expect(JSON.stringify(mockReportError.mock.calls[0][1])).not.toContain(WORKER);
  });

  it('erro que não é Error também é embrulhado', async () => {
    mockExecute.mockRejectedValue('boom');
    const res = fakeRes();
    await new TransitCorridorController().getCorridor(req(BODY), res);
    expect(res.statusCode).toBe(500);
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
  });

  it('sem uid na request a trilha registra null — nunca inventa quem consultou', async () => {
    mockExecute.mockResolvedValue(OK_RESULT);
    await new TransitCorridorController().getCorridor({ body: BODY } as unknown as Request, fakeRes());
    expect((mockInfo.mock.calls[0][0] as Record<string, unknown>).uid).toBeNull();
  });
});
