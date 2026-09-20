/**
 * EncuadreController.test.ts
 *
 * Testa o método updateWorkerStatus após a correção do bypass:
 * - status = 'REGISTERED' → chama recalculateStatus (nunca SET direto)
 * - status = 'DISABLED' / 'INCOMPLETE_REGISTER' → SET direto legítimo
 * - status inválido → 400
 *
 * ⚠️ ATUALIZADO NA C7/C8: toda transição que TOCA a baixa (entrar ou sair de
 * DISABLED) passa a exigir a célula `worker:disable` E um motivo escrito, e o
 * handler lê o estado atual + o autor da baixa antes de decidir. Por isso as
 * fixtures abaixo respondem à query de estado e passam `motivo`. Transição que
 * não toca a baixa (→ REGISTERED a partir de INCOMPLETE) segue como antes.
 */

/** A 1ª query do handler: estado atual + quem deu a baixa (C7/C8). */
function estadoAtual(status: string, autorDaBaixa: string | null = null) {
  return { rows: [{ status, autor_da_baixa: autorDaBaixa }] };
}

const CELULAS_COM_BAIXA = ['worker:write', 'worker:disable'];
const MOTIVO = 'Pedido por telefone, ticket 4412';

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockRecalculateStatus = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
        connect: mockConnect,
      }),
    }),
  },
}));

jest.mock('@modules/worker', () => ({
  ...jest.requireActual('@modules/worker'),
  WorkerRepository: jest.fn().mockImplementation(() => ({
    recalculateStatus: mockRecalculateStatus,
  })),
}));

jest.mock('../../../infrastructure/EncuadreRepository', () => ({
  EncuadreRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../infrastructure/JobPostingARRepository', () => ({
  JobPostingARRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@modules/audit', () => ({
  DocExpiryRepository: jest.fn().mockImplementation(() => ({})),
}));

import { EncuadreController } from '../EncuadreController';
import { Request, Response } from 'express';

function mockReqRes(params = {}, body = {}, user?: { uid: string }): [Request, Response] {
  const req = { params, body, query: {}, user } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

// Mock para runWorkerUpdate (usa pool.connect → client.query)
function setupMockClient() {
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  mockConnect.mockResolvedValue(mockClient);
  return mockClient;
}

describe('EncuadreController — updateWorkerStatus', () => {
  let controller: EncuadreController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new EncuadreController();
    setupMockClient();
  });

  // ── status inválido → 400 ──────────────────────────────────────────────

  it('retorna 400 para status inválido', async () => {
    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'approved' });

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(mockRecalculateStatus).not.toHaveBeenCalled();
  });

  // ── REGISTERED → chama recalculateStatus, nunca SET direto ─────────────

  it('chama recalculateStatus quando status = REGISTERED (worker incompleto)', async () => {
    mockRecalculateStatus.mockResolvedValue(null); // sem mudança — worker continua INCOMPLETE
    mockQuery.mockResolvedValueOnce(estadoAtual('INCOMPLETE_REGISTER'));
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] });

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'REGISTERED' }, { uid: 'admin-1' });

    await controller.updateWorkerStatus(req, res);

    expect(mockRecalculateStatus).toHaveBeenCalledWith('w1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { workerId: 'w1', status: 'INCOMPLETE_REGISTER' },
    });
  });

  it('chama recalculateStatus quando status = REGISTERED (worker completo)', async () => {
    mockRecalculateStatus.mockResolvedValue('REGISTERED');
    mockQuery.mockResolvedValueOnce(estadoAtual('INCOMPLETE_REGISTER'));
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'REGISTERED' }, { uid: 'admin-1' });

    await controller.updateWorkerStatus(req, res);

    expect(mockRecalculateStatus).toHaveBeenCalledWith('w1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { workerId: 'w1', status: 'REGISTERED' },
    });
  });

  it('REGISTERED nunca chama runWorkerUpdate (connect/BEGIN/COMMIT)', async () => {
    mockRecalculateStatus.mockResolvedValue(null);
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] });

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'REGISTERED' });

    await controller.updateWorkerStatus(req, res);

    // connect é usado por runWorkerUpdate — não deve ter sido chamado
    expect(mockConnect).not.toHaveBeenCalled();
  });

  // ── DISABLED → SET direto via runWorkerUpdate ──────────────────────────

  it('usa SET direto para status = DISABLED', async () => {
    // C7: dar baixa agora exige a célula E o motivo.
    mockQuery.mockResolvedValueOnce(estadoAtual('REGISTERED'));
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DISABLED' }] });

    const [req, res] = mockReqRes(
      { id: 'w1' }, { status: 'DISABLED', motivo: MOTIVO }, { uid: 'admin-1' },
    );
    (req as unknown as { permissionCells: string[] }).permissionCells = CELULAS_COM_BAIXA;

    await controller.updateWorkerStatus(req, res);

    // recalculateStatus NÃO deve ser chamado
    expect(mockRecalculateStatus).not.toHaveBeenCalled();
    // connect é chamado (runWorkerUpdate usa transação)
    expect(mockConnect).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { workerId: 'w1', status: 'DISABLED' },
    });
  });

  // ── INCOMPLETE_REGISTER → SET direto via runWorkerUpdate ──────────────

  it('usa SET direto para status = INCOMPLETE_REGISTER', async () => {
    // Vindo de REGISTERED não toca a baixa — segue sem célula e sem motivo.
    mockQuery.mockResolvedValueOnce(estadoAtual('REGISTERED'));
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] });

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'INCOMPLETE_REGISTER' }, { uid: 'admin-1' });

    await controller.updateWorkerStatus(req, res);

    expect(mockRecalculateStatus).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { workerId: 'w1', status: 'INCOMPLETE_REGISTER' },
    });
  });

  // ── Erro interno → 500 ────────────────────────────────────────────────

  it('retorna 500 quando recalculateStatus lança exceção', async () => {
    mockRecalculateStatus.mockRejectedValue(new Error('DB down'));

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'REGISTERED' });

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  // ── C7/C8 — a baixa no CONTROLLER, não só no domínio ────────────────────

  it('C7 — sem `worker:disable`, dar baixa é 403 e o UPDATE não roda', async () => {
    mockQuery.mockResolvedValueOnce(estadoAtual('REGISTERED'));

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'DISABLED', motivo: MOTIVO }, { uid: 'admin-1' });
    (req as unknown as { permissionCells: string[] }).permissionCells = ['worker:write'];

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    // O ponto: negar DEPOIS de escrever não é negar.
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('C7 — o furo: DISABLED → INCOMPLETE_REGISTER sem a célula é 403', async () => {
    mockQuery.mockResolvedValueOnce(estadoAtual('DISABLED', 'admin-antigo'));

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'INCOMPLETE_REGISTER', motivo: MOTIVO }, { uid: 'admin-1' });
    (req as unknown as { permissionCells: string[] }).permissionCells = ['worker:write'];

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('C7 — com a célula e SEM motivo, é 403: o motivo é o que a auditoria lê', async () => {
    mockQuery.mockResolvedValueOnce(estadoAtual('REGISTERED'));

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'DISABLED' }, { uid: 'admin-1' });
    (req as unknown as { permissionCells: string[] }).permissionCells = CELULAS_COM_BAIXA;

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('C8 — baixa pedida pelo TITULAR não é revertida nem com a célula', async () => {
    mockQuery.mockResolvedValueOnce(estadoAtual('DISABLED', 'worker_self:uid-do-prestador'));

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'REGISTERED', motivo: MOTIVO }, { uid: 'admin-1' });
    (req as unknown as { permissionCells: string[] }).permissionCells = CELULAS_COM_BAIXA;

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    // Nem por recalculateStatus, que é o caminho do REGISTERED.
    expect(mockRecalculateStatus).not.toHaveBeenCalled();
  });

  it('C8 — baixa dada por ADMIN continua revertível com a célula', async () => {
    mockRecalculateStatus.mockResolvedValue('REGISTERED');
    mockQuery.mockResolvedValueOnce(estadoAtual('DISABLED', 'admin-antigo'));
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });

    const [req, res] = mockReqRes({ id: 'w1' }, { status: 'REGISTERED', motivo: MOTIVO }, { uid: 'admin-1' });
    (req as unknown as { permissionCells: string[] }).permissionCells = CELULAS_COM_BAIXA;

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockRecalculateStatus).toHaveBeenCalledWith('w1');
  });

  it('worker inexistente é 404, e não 403 — a causa dita tem de ser a real', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes({ id: 'nao-existe' }, { status: 'DISABLED', motivo: MOTIVO }, { uid: 'admin-1' });
    (req as unknown as { permissionCells: string[] }).permissionCells = CELULAS_COM_BAIXA;

    await controller.updateWorkerStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
