/**
 * C6 — a trilha agregada. O que estes testes travam é o que a linha NÃO leva.
 */

const mockQuery = jest.fn();
const mockWarn = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));
jest.mock('@shared/logging', () => ({ logger: { warn: mockWarn, error: jest.fn(), info: jest.fn() } }));
jest.mock('@shared/database/requestDbSession', () => ({
  withSystemDbContext: (_l: string, fn: () => Promise<void>) => fn(),
}));

import { recordContactAccess, emitContactAccess } from '../contactAccessLog';
import { PRESTADOR_CANARIO } from '../../../modules/matching/__tests__/guardaVazamentoPrestador';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const W1 = '11111111-1111-1111-1111-111111111111';
const W2 = '22222222-2222-2222-2222-222222222222';
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('trilha agregada de contato', () => {
  it('UMA linha por request, com o conjunto de prestadores e o n batendo', async () => {
    await recordContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [W1, W2],
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('iam.contact_access_log');
    expect(params).toEqual([TENANT, 'u-ana', 'worker_contact:read', [W1, W2], 2, null]);
  });

  it('deduplica — a mesma pessoa em dois cards conta UMA vez', async () => {
    // `n` conta PESSOAS, não linhas de tela. Sem isto o número mente para cima
    // e a F11 montaria grupo com base em volume inflado.
    await recordContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [W1, W2, W1],
    });
    expect(mockQuery.mock.calls[0][1][3]).toEqual([W1, W2]);
    expect(mockQuery.mock.calls[0][1][4]).toBe(2);
  });

  it('request que redigiu TUDO não vira linha — nada foi revelado', async () => {
    await recordContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [],
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('nem lista só de vazios vira linha', async () => {
    await recordContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read',
      workerIds: ['', null as unknown as string],
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('FRONTEIRA: nem telefone, nem nome, nem path atravessam para o banco', async () => {
    await recordContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [W1],
    });
    const tudo = JSON.stringify(mockQuery.mock.calls);
    for (const proibido of [
      PRESTADOR_CANARIO.telefone, PRESTADOR_CANARIO.nomeCompleto, PRESTADOR_CANARIO.whatsapp,
      '/api/admin/vacancies',
    ]) {
      expect(tudo).not.toContain(proibido);
    }
  });

  it('o país entra quando há contexto, e vira null quando não há', async () => {
    await recordContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [W1], country: 'AR',
    });
    expect(mockQuery.mock.calls[0][1][5]).toBe('AR');
  });

  it('falha de gravação NÃO derruba a request — vira aviso', async () => {
    mockQuery.mockRejectedValue(new Error('banco fora'));
    expect(() => emitContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [W1],
    })).not.toThrow();
    await flush();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('o log de FALHA não leva os ids — senão o Cloud Logging ganha o vínculo', async () => {
    mockQuery.mockRejectedValue(new Error('banco fora'));
    emitContactAccess({
      tenantId: TENANT, operatorUid: 'u-ana', cell: 'worker_contact:read', workerIds: [W1, W2],
    });
    await flush();

    const logado = JSON.stringify(mockWarn.mock.calls);
    expect(logado).not.toContain(W1);
    expect(logado).not.toContain(W2);
    // mas o que dá para agir SEM identificar continua lá
    expect(logado).toContain('u-ana');
    expect(logado).toContain('worker_contact:read');
  });
});
