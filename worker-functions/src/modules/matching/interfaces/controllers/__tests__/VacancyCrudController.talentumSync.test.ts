/**
 * VacancyCrudController.updateVacancy — D3 c/d (propagação ao Talentum) e D4 (campo aditivo `talentumSync`).
 * Talentum, Gemini e pause service são dublês: nenhuma chamada sai para a rede.
 */
import type { Request, Response } from 'express';

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockConnect = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockQuery, connect: mockConnect }) }) },
}));

const mockAuthorize = jest.fn();
jest.mock('../vacancyCrudHelpers', () => ({
  ...jest.requireActual('../vacancyCrudHelpers'),
  authorizeVacancyUpdate: (...a: any[]) => (mockAuthorize as any)(...a),
  withEffectiveFields: async (_db: unknown, row: unknown) => row,
}));
jest.mock('../vacancyCrudAuditHelpers', () => ({
  auditVacancyUpdated: jest.fn().mockResolvedValue(undefined),
  vacancyActorFromRequest: () => ({ actorUserId: 'admin-1', actorType: 'HUMAN', actorLabel: 'admin_panel', traceId: null }),
}));
jest.mock('../vacancyDeBajaGuard', () => ({ sendVacancyDeBajaRefusal: jest.fn() }));
jest.mock('../../../application/EnsureVacancyShortLinkUseCase', () => ({ EnsureVacancyShortLinkUseCase: jest.fn().mockImplementation(() => ({ execute: jest.fn() })) }));
jest.mock('../../../application/PurgeVacancyShortLinksUseCase', () => ({ PurgeVacancyShortLinksUseCase: jest.fn().mockImplementation(() => ({ execute: jest.fn() })) }));
jest.mock('../../../infrastructure/shortlinks/ShortLinkService', () => ({ ShortLinkService: { fromEnv: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), loggingAls: { getStore: jest.fn().mockReturnValue(undefined) } }));
jest.mock('@modules/case', () => ({ countVigenteForVacancy: jest.fn().mockResolvedValue(0) }));
jest.mock('@shared/database/actorContext', () => ({ withActorContext: jest.fn() }));
jest.mock('@shared/database/requestDbSession', () => ({ withSystemDbContext: (_l: string, fn: () => Promise<unknown>) => fn() }));

const mockGenerate = jest.fn();
const mockPropagate = jest.fn();
jest.mock('@modules/integration', () => ({
  TalentumDescriptionService: jest.fn().mockImplementation(() => ({ generateDescription: mockGenerate })),
  SyncVacancyContentToTalentumUseCase: jest.fn().mockImplementation(() => ({ propagate: mockPropagate })),
}));
const mockPause = jest.fn();
const mockResume = jest.fn();
jest.mock('../../../application/VacancyTalentumPauseService', () => ({
  VacancyTalentumPauseService: jest.fn().mockImplementation(() => ({ pause: mockPause, resume: mockResume })),
}));

import { VacancyCrudController } from '../VacancyCrudController';

const res = (): Response => { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (body: unknown): Request => ({ body, params: { id: 'jp-1' }, user: { uid: 'admin-1' } } as unknown as Request);

const SCHED_A = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
const SCHED_B = [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }];

/** `before` e `after` = linhas cruas da vaga (SELECT antes / RETURNING do UPDATE). */
function db(before: Record<string, unknown>, after: Record<string, unknown>) {
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: jest.fn() });
  mockClientQuery.mockReset()
    .mockResolvedValueOnce({})                  // BEGIN
    .mockResolvedValueOnce({ rows: [before] })  // SELECT before
    .mockResolvedValueOnce({ rows: [after] })   // UPDATE ... RETURNING
    .mockResolvedValue({ rows: [] });           // COMMIT
}

describe('VacancyCrudController.updateVacancy → Talentum (D3 c/d, D4)', () => {
  let controller: VacancyCrudController;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerate.mockReset().mockResolvedValue({ description: 'nova' });
    mockPropagate.mockReset().mockResolvedValue({ status: 'OK' });
    mockPause.mockReset().mockResolvedValue([{ vacancyId: 'jp-1', state: 'PAUSED', attempted: true }]);
    mockResume.mockReset().mockResolvedValue([{ vacancyId: 'jp-1', state: null, attempted: true }]);
    controller = new VacancyCrudController();
  });

  it('(c) vaga publicada + schedule alterado: grava, regera a descrição, propaga e devolve talentumSync', async () => {
    mockAuthorize.mockResolvedValue({ kind: 'ok', isDraft: false, currentStatus: 'ACTIVE' });
    db({ id: 'jp-1', status: 'ACTIVE', schedule: SCHED_A }, { id: 'jp-1', status: 'ACTIVE', schedule: SCHED_B, talentum_project_id: 'proj-1' });
    const r = res();

    await controller.updateVacancy(req({ schedule: SCHED_B }), r);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockPropagate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.invocationCallOrder[0]).toBeLessThan(mockPropagate.mock.invocationCallOrder[0]);
    expect(mockPause).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect((r.json as jest.Mock).mock.calls[0][0]).toMatchObject({ success: true, talentumSync: { status: 'OK' } });
  });

  it('(c) schedule enviado IGUAL ao atual: não regera nem propaga (sem talentumSync)', async () => {
    mockAuthorize.mockResolvedValue({ kind: 'ok', isDraft: false, currentStatus: 'ACTIVE' });
    db({ id: 'jp-1', status: 'ACTIVE', schedule: SCHED_A }, { id: 'jp-1', status: 'ACTIVE', schedule: SCHED_A, talentum_project_id: 'proj-1' });
    const r = res();
    await controller.updateVacancy(req({ schedule: SCHED_A }), r);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockPropagate).not.toHaveBeenCalled();
    expect((r.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('talentumSync');
  });

  it('rascunho / sem projeto no Talentum: grava e NÃO chama Gemini, cliente nem pause', async () => {
    mockAuthorize.mockResolvedValue({ kind: 'ok', isDraft: false, currentStatus: 'ACTIVE' });
    db({ id: 'jp-1', status: 'ACTIVE', schedule: SCHED_A }, { id: 'jp-1', status: 'ON_HOLD', schedule: SCHED_B, talentum_project_id: null });
    const r = res();
    await controller.updateVacancy(req({ schedule: SCHED_B, status: 'ON_HOLD' }), r);
    expect([mockGenerate, mockPropagate, mockPause, mockResume].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0]);
    expect(r.status).toHaveBeenCalledWith(200);
    expect((r.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('talentumSync');
  });

  it.each([
    ['ACTIVE', 'ON_HOLD', 'pause'], ['SEARCHING', 'CLOSED', 'pause'], ['ACTIVE', 'SUSPENDED', 'pause'],
    ['ON_HOLD', 'ACTIVE', 'resume'], ['CLOSED', 'SEARCHING', 'resume'],
  ])('(d) status %s → %s: %s', async (from, to, action) => {
    mockAuthorize.mockResolvedValue({ kind: 'ok', isDraft: false, currentStatus: from });
    db({ id: 'jp-1', status: from }, { id: 'jp-1', status: to, talentum_project_id: 'proj-1' });
    const r = res();
    await controller.updateVacancy(req({ status: to }), r);
    expect(action === 'pause' ? mockPause : mockResume).toHaveBeenCalledWith(['jp-1']);
    expect(action === 'pause' ? mockResume : mockPause).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect((r.json as jest.Mock).mock.calls[0][0]).toMatchObject({ talentumSync: { status: 'OK' } });
  });

  it('(d) mudança dentro do mesmo grupo (ON_HOLD → CLOSED, ACTIVE → SEARCHING): nada é chamado', async () => {
    for (const [from, to] of [['ON_HOLD', 'CLOSED'], ['ACTIVE', 'SEARCHING']]) {
      mockAuthorize.mockResolvedValue({ kind: 'ok', isDraft: false, currentStatus: from });
      db({ id: 'jp-1', status: from }, { id: 'jp-1', status: to, talentum_project_id: 'proj-1' });
      const r = res();
      await controller.updateVacancy(req({ status: to }), r);
      expect((r.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('talentumSync');
    }
    expect(mockPause.mock.calls.length + mockResume.mock.calls.length).toBe(0);
  });

  it('(D4) o Talentum recusa: a gravação local fica (200) e talentumSync = FAILED', async () => {
    mockAuthorize.mockResolvedValue({ kind: 'ok', isDraft: false, currentStatus: 'ACTIVE' });
    db({ id: 'jp-1', status: 'ACTIVE' }, { id: 'jp-1', status: 'ON_HOLD', talentum_project_id: 'proj-1' });
    mockPause.mockResolvedValue([{ vacancyId: 'jp-1', state: 'MANUAL_PAUSE', attempted: true }]);
    const r = res();
    await controller.updateVacancy(req({ status: 'ON_HOLD' }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect((r.json as jest.Mock).mock.calls[0][0]).toMatchObject({ success: true, talentumSync: { status: 'FAILED' } });
  });
});
