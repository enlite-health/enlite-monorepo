/**
 * AnalyticsDashboardController.other-methods.test.ts
 *
 * Cobertura das rotas do arquivo NÃO tocadas pela lógica do PR-9 (país no
 * management dashboard vive em `AnalyticsDashboardController.getManagementMetrics.test.ts`).
 * Escrito só para fechar "cobertura 100% do arquivo tocado" (perfil.md, D200.12) —
 * comportamento pré-existente, sem decisão nova: getGlobalMetrics, getCaseMetrics,
 * getZoneMetrics, getReemplazosMetrics, getZoneAnalytics.
 */
const mockFindActiveCases = jest.fn();
const mockCountByZone = jest.fn();
const mockCountByChannel = jest.fn();
const mockCountAttended = jest.fn();
const mockFindByCaseNumber = jest.fn();
const mockCountByJobPosting = jest.fn();
const mockCountCandidatesByJobPosting = jest.fn();
const mockCountInvitedAndAttended = jest.fn();
const mockCountByResultado = jest.fn();
const mockCountByChannelForJobPosting = jest.fn();
const mockFindByJobPosting = jest.fn();
const mockFindByCaseNumberJob = jest.fn();
const mockCountSelAndRemByCaseNumber = jest.fn();
const mockFindLastPublicationPerCase = jest.fn();
const mockCountCandidatosByCaseNumber = jest.fn();
const mockCountPostuladosByCaseNumber = jest.fn();
const mockZoneAnalyticsExecute = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('../../../../../infrastructure/repositories/ClickUpCaseRepository', () => ({
  ClickUpCaseRepository: jest.fn().mockImplementation(() => ({
    findActiveCases: mockFindActiveCases,
    countByZone: mockCountByZone,
    findByCaseNumber: mockFindByCaseNumber,
  })),
}));

jest.mock('@modules/audit', () => ({
  PublicationRepository: jest.fn().mockImplementation(() => ({
    countByChannel: mockCountByChannel,
    countByChannelForJobPosting: mockCountByChannelForJobPosting,
    findByJobPosting: mockFindByJobPosting,
    findLastPublicationPerCase: mockFindLastPublicationPerCase,
  })),
}));

jest.mock('../../../infrastructure/EncuadreRepository', () => ({
  EncuadreRepository: jest.fn().mockImplementation(() => ({
    countAttended: mockCountAttended,
    countCandidatesByJobPosting: mockCountCandidatesByJobPosting,
    countInvitedAndAttended: mockCountInvitedAndAttended,
    countByResultado: mockCountByResultado,
    countSelAndRemByCaseNumber: mockCountSelAndRemByCaseNumber,
  })),
}));

jest.mock('../../../infrastructure/WorkerApplicationRepository', () => ({
  WorkerApplicationRepository: jest.fn().mockImplementation(() => ({
    countByJobPosting: mockCountByJobPosting,
    countCandidatesByCaseNumber: mockCountCandidatosByCaseNumber,
    countPostuladosByCaseNumber: mockCountPostuladosByCaseNumber,
  })),
}));

jest.mock('../../../infrastructure/JobPostingARRepository', () => ({
  JobPostingARRepository: jest.fn().mockImplementation(() => ({
    findByCaseNumber: mockFindByCaseNumberJob,
  })),
}));

jest.mock('../../../application/GetZoneAnalyticsUseCase', () => ({
  GetZoneAnalyticsUseCase: jest.fn().mockImplementation(() => ({ execute: mockZoneAnalyticsExecute })),
}));

import { AnalyticsDashboardController } from '../AnalyticsDashboardController';

function makeReq(query: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return { query, params } as unknown as import('express').Request;
}

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

describe('AnalyticsDashboardController — demais rotas (cobertura de arquivo tocado)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getGlobalMetrics', () => {
    it('sucesso: agrega contagens e busquedaCount/reemplazoCount pelo status', async () => {
      mockFindActiveCases.mockResolvedValue([
        { status: 'SEARCHING' },
        { status: 'SEARCHING_REPLACEMENT' },
        { status: 'CLOSED' },
      ]);
      mockCountByChannel.mockResolvedValue([{ channel: 'whatsapp', count: 3 }, { channel: null, count: 1 }]);
      mockCountAttended.mockResolvedValue(7);
      // countByStatus faz query direta no pool — usa o mock do DatabaseConnection.
      const controller = new AnalyticsDashboardController();
      (controller as unknown as { db: { query: jest.Mock } }).db.query = jest.fn().mockResolvedValue({ rows: [{ count: 5 }] });

      const res = makeRes();
      await controller.getGlobalMetrics(makeReq({}), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            activeCasesCount: 3,
            busquedaCount: 1,
            reemplazoCount: 1,
            postulantesInTalentumCount: 5,
            candidatosEnProgresoCount: 5,
            totalPubs: 4,
            cantidadEncuadres: 7,
          }),
        }),
      );
    });

    it('erro → 500', async () => {
      mockFindActiveCases.mockRejectedValue(new Error('boom'));
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getGlobalMetrics(makeReq({}), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('com startDate/endDate: os dois entram no WHERE de countByStatus', async () => {
      mockFindActiveCases.mockResolvedValue([]);
      mockCountByChannel.mockResolvedValue([]);
      mockCountAttended.mockResolvedValue(0);
      const controller = new AnalyticsDashboardController();
      const dbQuery = jest.fn().mockResolvedValue({ rows: [{ count: 1 }] });
      (controller as unknown as { db: { query: jest.Mock } }).db.query = dbQuery;

      await controller.getGlobalMetrics(
        makeReq({ startDate: '2026-01-01', endDate: '2026-01-31' }),
        makeRes(),
      );

      const [sql, values] = dbQuery.mock.calls[0];
      expect(sql).toContain('w.created_at >=');
      expect(sql).toContain('w.created_at <=');
      expect(values).toEqual(['REGISTERED', '2026-01-01', '2026-01-31', 'AR']);
    });

    it('`?country=` string vazia (falsy, mas NÃO undefined) não aciona o default e pula o predicado de país', async () => {
      // Destructuring default só entra para `undefined` — `country=''` na query passa
      // direto como '' e cai no ramo falso de `if (filters.country)`.
      mockFindActiveCases.mockResolvedValue([]);
      mockCountByChannel.mockResolvedValue([]);
      mockCountAttended.mockResolvedValue(0);
      const controller = new AnalyticsDashboardController();
      const dbQuery = jest.fn().mockResolvedValue({ rows: [{ count: 0 }] });
      (controller as unknown as { db: { query: jest.Mock } }).db.query = dbQuery;

      await controller.getGlobalMetrics(makeReq({ country: '' }), makeRes());

      const [sql, values] = dbQuery.mock.calls[0];
      expect(sql).not.toContain('w.country');
      expect(values).toEqual(['REGISTERED']);
    });

    it('countByStatus sem NENHUMA linha (rows=[]) cai no fallback `?? 0`, nunca undefined', async () => {
      mockFindActiveCases.mockResolvedValue([]);
      mockCountByChannel.mockResolvedValue([]);
      mockCountAttended.mockResolvedValue(0);
      const controller = new AnalyticsDashboardController();
      (controller as unknown as { db: { query: jest.Mock } }).db.query = jest.fn().mockResolvedValue({ rows: [] });

      const res = makeRes();
      await controller.getGlobalMetrics(makeReq({}), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ postulantesInTalentumCount: 0, candidatosEnProgresoCount: 0 }) }),
      );
    });
  });

  describe('getZoneMetrics', () => {
    it('sucesso: agrega por zona, exclui null do ranking mas conta no total', async () => {
      mockCountByZone.mockResolvedValue([
        { zone: 'Palermo', count: 10 },
        { zone: 'Belgrano', count: 5 },
        { zone: null, count: 2 },
      ]);
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneMetrics(makeReq({}), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ total: 17, nullCount: 2, validTotal: 15, maxCount: 10 }),
        }),
      );
    });

    it('zona com count=0 (anomalia de dado): validTotal/total ficam 0 e o pct do item cai no fallback', async () => {
      mockCountByZone.mockResolvedValue([{ zone: 'ZonaVazia', count: 0 }]);
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneMetrics(makeReq({}), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            zonas: [{ name: 'ZonaVazia', count: 0, pct: 0, pctOfTotal: 0 }],
          }),
        }),
      );
    });

    it('sem nenhuma zona: total=0 não divide por zero (pct e nullPct viram 0)', async () => {
      mockCountByZone.mockResolvedValue([]);
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneMetrics(makeReq({}), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ zonas: [], total: 0, nullCount: 0, validTotal: 0, maxCount: 0, nullPct: '0.0' }),
        }),
      );
    });

    it('erro → 500', async () => {
      mockCountByZone.mockRejectedValue(new Error('boom'));
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneMetrics(makeReq({}), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getReemplazosMetrics', () => {
    it('sucesso: monta lastPubDates/lastPubChannels por caseNumber', async () => {
      mockCountSelAndRemByCaseNumber.mockResolvedValue([{ caseNumber: 1, sel: 2, rem: 1 }]);
      mockFindLastPublicationPerCase.mockResolvedValue([{ caseNumber: 1, timeAgo: '2h', channel: 'whatsapp' }]);
      mockCountCandidatosByCaseNumber.mockResolvedValue([{ caseNumber: 1, count: 4 }]);
      mockCountPostuladosByCaseNumber.mockResolvedValue([{ caseNumber: 1, count: 6 }]);

      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getReemplazosMetrics(makeReq({}), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            lastPubDates: { '1': '2h' },
            lastPubChannels: { '1': 'whatsapp' },
          }),
        }),
      );
    });

    it('erro → 500', async () => {
      mockCountSelAndRemByCaseNumber.mockRejectedValue(new Error('boom'));
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getReemplazosMetrics(makeReq({}), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getCaseMetrics', () => {
    it('caseNumber inválido (NaN) → 400', async () => {
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getCaseMetrics(makeReq({}, { caseNumber: 'abc' }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('caso não encontrado em job_postings → 404', async () => {
      mockFindByCaseNumberJob.mockResolvedValue(null);
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getCaseMetrics(makeReq({}, { caseNumber: '42' }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso: agrega clickUp + candidatos + publicações + resultados', async () => {
      mockFindByCaseNumberJob.mockResolvedValue({ id: 'jp-1' });
      mockFindByCaseNumber.mockResolvedValue({ id: 'cu-1' });
      mockCountByJobPosting.mockResolvedValue(9);
      mockCountCandidatesByJobPosting.mockResolvedValue(3);
      mockCountInvitedAndAttended.mockResolvedValue({ invitados: 10, asistentes: 5 });
      mockCountByResultado.mockResolvedValue([
        { resultado: 'SELECCIONADO', count: 2 },
        { resultado: 'REEMPLAZO', count: 1 },
      ]);
      mockCountByChannelForJobPosting.mockResolvedValue([{ channel: 'whatsapp', count: 3 }]);
      mockFindByJobPosting.mockResolvedValue([
        { publishedAt: new Date('2026-01-01'), channel: 'whatsapp', recruiterName: 'A', observations: null },
      ]);

      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getCaseMetrics(makeReq({}, { caseNumber: '42' }), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            postuladosCount: 9,
            candidatosCount: 3,
            invitados: 10,
            asistentes: 5,
            asistenciaPct: 50,
            seleccionadosCount: 2,
            reemplazosCount: 1,
          }),
        }),
      );
    });

    it('invitados=0 → asistenciaPct 0 (sem divisão por zero)', async () => {
      mockFindByCaseNumberJob.mockResolvedValue({ id: 'jp-1' });
      mockFindByCaseNumber.mockResolvedValue(null);
      mockCountByJobPosting.mockResolvedValue(0);
      mockCountCandidatesByJobPosting.mockResolvedValue(0);
      mockCountInvitedAndAttended.mockResolvedValue({ invitados: 0, asistentes: 0 });
      mockCountByResultado.mockResolvedValue([]);
      // channel null: exercita o fallback `?? 'Sin canal'` de `pubChartData`.
      mockCountByChannelForJobPosting.mockResolvedValue([{ channel: null, count: 2 }]);
      // publishedAt ausente + observations ausente: exercita os fallbacks `?.`/`??`
      // ("Sin fecha"/""") que o caso "sucesso" (com Date real) não cobre.
      mockFindByJobPosting.mockResolvedValue([
        { publishedAt: null, channel: null, recruiterName: 'B', observations: undefined },
      ]);

      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getCaseMetrics(makeReq({}, { caseNumber: '7' }), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            asistenciaPct: 0,
            seleccionadosCount: 0,
            reemplazosCount: 0,
            publicacionesList: [{ fecha: 'Sin fecha', canal: null, publicadoPor: 'B', descripcion: '' }],
          }),
        }),
      );
    });

    it('erro → 500', async () => {
      mockFindByCaseNumberJob.mockRejectedValue(new Error('boom'));
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getCaseMetrics(makeReq({}, { caseNumber: '1' }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getZoneAnalytics', () => {
    it('profession inválida → 400', async () => {
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneAnalytics(makeReq({ profession: 'INVALIDA' }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('sucesso sem profession (null)', async () => {
      mockZoneAnalyticsExecute.mockResolvedValue({ zonas: [] });
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneAnalytics(makeReq({}), res);
      expect(mockZoneAnalyticsExecute).toHaveBeenCalledWith({ profession: null });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { zonas: [] } });
    });

    it('erro → 500', async () => {
      mockZoneAnalyticsExecute.mockRejectedValue(new Error('boom'));
      const controller = new AnalyticsDashboardController();
      const res = makeRes();
      await controller.getZoneAnalytics(makeReq({}), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
