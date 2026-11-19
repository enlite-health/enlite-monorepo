jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  toSafeError: jest.requireActual('@shared/logging/safeError').toSafeError,
}));

import type { Request, Response } from 'express';
import { logger, reportError } from '@shared/logging';
import { AccountInactiveError } from '../../../application/GetWorkerItineraryUseCase';
import { InvalidTemplateWindowError } from '../../../application/dailyReport/GetReportTemplatesUseCase';
import { DailyReportConflictError, DailyReportError } from '../../../domain/DailyReport';
import { WorkerDailyReportMeController } from '../WorkerDailyReportMeController';

const ESPIA = 'NARRATIVA-ESPIA-092';
const UUID = '11111111-1111-4111-8111-111111111111';
const OCC = '22222222-2222-4222-8222-222222222222';

function mk(over: { user?: unknown; params?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) {
  const json = jest.fn();
  const end = jest.fn();
  const status = jest.fn().mockReturnValue({ json, end });
  const setHeader = jest.fn();
  const req = { user: 'user' in over ? over.user : { uid: 'uid-1' }, params: over.params ?? {}, query: over.query ?? {}, body: over.body, headers: over.headers ?? {} } as unknown as Request;
  return { req, res: { status, setHeader } as unknown as Response, status, json, end, setHeader };
}
const validBody = () => ({
  occurrenceId: OCC, ptiVersionId: null, narrative: ESPIA, narrativeSource: 'TYPED', deviceSubmittedAt: '2026-11-17T12:00:00.000Z', appVersion: '1.0.0',
  answers: [{ objectiveId: UUID, scaleCode: 'SN', optionCode: 'si' }, { activityId: OCC, scaleCode: 'CNT', countValue: 2 }],
});

describe('WorkerDailyReportMeController', () => {
  const catalog = { execute: jest.fn() };
  const templates = { execute: jest.fn() };
  const submit = { execute: jest.fn() };
  const ctrl = new WorkerDailyReportMeController(catalog as never, templates as never, submit as never);
  beforeEach(() => jest.clearAllMocks());

  describe('getScales', () => {
    it('401 sem uid', async () => {
      const m = mk({ user: undefined });
      await ctrl.getScales(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(401);
    });
    it('200 com ETag; 304 quando If-None-Match é o ETag', async () => {
      catalog.execute.mockResolvedValue({ version: 'abc', scales: [] });
      const ok = mk();
      await ctrl.getScales(ok.req, ok.res);
      expect(ok.setHeader).toHaveBeenCalledWith('ETag', '"abc"');
      expect([ok.status.mock.calls[0][0], ok.json.mock.calls[0][0]]).toEqual([200, { version: 'abc', scales: [] }]);
      const cached = mk({ headers: { 'if-none-match': '"abc"' } });
      await ctrl.getScales(cached.req, cached.res);
      expect(cached.status).toHaveBeenCalledWith(304);
      expect(cached.end).toHaveBeenCalled();
    });
    it('erro inesperado → 500', async () => {
      catalog.execute.mockRejectedValueOnce(new Error('x'));
      const m = mk();
      await ctrl.getScales(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(500);
    });
  });

  describe('getTemplates', () => {
    it('401 sem uid; 400 com query inválida (só caminhos)', async () => {
      const a = mk({ user: undefined });
      await ctrl.getTemplates(a.req, a.res);
      expect(a.status).toHaveBeenCalledWith(401);
      const b = mk({ query: { from: 'ontem', to: '2026-11-17' } });
      await ctrl.getTemplates(b.req, b.res);
      expect(b.status).toHaveBeenCalledWith(400);
      expect(b.json.mock.calls[0][0]).toMatchObject({ code: 'invalid_query', details: ['from'] });
    });
    it('200 com o molde; today vem do servidor', async () => {
      templates.execute.mockResolvedValueOnce({ items: [] });
      const m = mk({ query: { from: '2026-11-16', to: '2026-11-17' } });
      await ctrl.getTemplates(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(200);
      expect(templates.execute.mock.calls[0][0]).toMatchObject({ uid: 'uid-1', from: '2026-11-16', to: '2026-11-17' });
      expect(templates.execute.mock.calls[0][0].today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    it('janela inválida do use case → 400; conta inativa → 403', async () => {
      templates.execute.mockRejectedValueOnce(new InvalidTemplateWindowError());
      const a = mk({ query: { from: '2026-11-16', to: '2026-11-17' } });
      await ctrl.getTemplates(a.req, a.res);
      expect([a.status.mock.calls[0][0], a.json.mock.calls[0][0].code]).toEqual([400, 'invalid_window']);
      templates.execute.mockRejectedValueOnce(new AccountInactiveError());
      const b = mk({ query: { from: '2026-11-16', to: '2026-11-17' } });
      await ctrl.getTemplates(b.req, b.res);
      expect([b.status.mock.calls[0][0], b.json.mock.calls[0][0]]).toEqual([403, { code: 'ACCOUNT_INACTIVE' }]);
    });
  });

  describe('put', () => {
    it('401 sem uid', async () => {
      const m = mk({ user: undefined, params: { reportId: UUID }, body: validBody() });
      await ctrl.put(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(401);
    });
    it('400: id que não é uuid e corpo inválido — o corpo da resposta tem só caminhos, nunca o valor', async () => {
      const m = mk({ params: { reportId: 'nope' }, body: { ...validBody(), narrative: '  ', narrativeSource: ESPIA, answers: [{ scaleCode: 'SN' }] } });
      await ctrl.put(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(400);
      const out = m.json.mock.calls[0][0];
      expect(out.details).toEqual(expect.arrayContaining(['id', 'narrative', 'narrativeSource']));
      expect(JSON.stringify(out)).not.toContain(ESPIA);
      expect(submit.execute).not.toHaveBeenCalled();
      const soId = mk({ params: { reportId: 'nope' }, body: validBody() });
      await ctrl.put(soId.req, soId.res);
      expect(soId.json.mock.calls[0][0].details).toEqual(['id']);
    });
    it('400: item repetido, motivo sem opção e campo desconhecido (strict)', async () => {
      const dup = { ...validBody(), answers: [{ objectiveId: UUID, scaleCode: 'SN', optionCode: 'si' }, { objectiveId: UUID, scaleCode: 'SN', optionCode: 'no' }] };
      const noOpt = { ...validBody(), answers: [{ objectiveId: UUID, scaleCode: 'CNT', countValue: 1, reasonCode: 'x' }] };
      const extra = { ...validBody(), paciente: 'x' };
      for (const b of [dup, noOpt, extra]) {
        const m = mk({ params: { reportId: UUID }, body: b });
        await ctrl.put(m.req, m.res);
        expect(m.status).toHaveBeenCalledWith(400);
      }
    });
    it('201 quando criou, 200 quando repetiu; o log leva reportId/contagem/resultado e NUNCA a narrativa; as respostas viram sealed', async () => {
      submit.execute.mockResolvedValueOnce('created').mockResolvedValueOnce('replayed');
      const a = mk({ params: { reportId: UUID }, body: validBody() });
      await ctrl.put(a.req, a.res);
      expect([a.status.mock.calls[0][0], a.json.mock.calls[0][0]]).toEqual([201, { id: UUID }]);
      const b = mk({ params: { reportId: UUID }, body: validBody() });
      await ctrl.put(b.req, b.res);
      expect(b.status.mock.calls[0][0]).toBe(200);
      const cmd = submit.execute.mock.calls[0][0];
      expect(cmd.answers).toEqual([
        { itemKind: 'objective', itemId: UUID, scaleCode: 'SN', answer: { kind: 'choice', optionCode: 'si', reasonCode: null } },
        { itemKind: 'activity', itemId: OCC, scaleCode: 'CNT', answer: { kind: 'count', value: 2 } },
      ]);
      expect(cmd.deviceSubmittedAt).toEqual(new Date('2026-11-17T12:00:00.000Z'));
      const logged = JSON.stringify((logger.info as jest.Mock).mock.calls);
      expect(logged).toContain(UUID);
      expect(logged).not.toContain(ESPIA);
    });
    it('409 conflito, 422 regra, 403 conta inativa — corpo só com o código', async () => {
      for (const [err, st, code] of [
        [new DailyReportConflictError('daily_report_conflict'), 409, 'daily_report_conflict'],
        [new DailyReportConflictError('daily_report_exists'), 409, 'daily_report_exists'],
        [new DailyReportError('reason_required'), 422, 'reason_required'],
        [new AccountInactiveError(), 403, 'ACCOUNT_INACTIVE'],
      ] as const) {
        submit.execute.mockRejectedValueOnce(err);
        const m = mk({ params: { reportId: UUID }, body: validBody() });
        await ctrl.put(m.req, m.res);
        expect([m.status.mock.calls[0][0], m.json.mock.calls[0][0].code]).toEqual([st, code]);
        expect(JSON.stringify(m.json.mock.calls[0][0])).not.toContain(ESPIA);
      }
    });
    it('PRIVACIDADE: erro do driver pg com a LINHA no detail (inclui a narrativa) vira 500 sem corpo útil e sem a narrativa no que vai ao reportError', async () => {
      const pgErr = Object.assign(new Error(`new row for relation "daily_reports" violates check constraint "x"\nDETAIL: Failing row contains (${ESPIA})`), {
        code: '23514', constraint: 'daily_reports_narrative_len', detail: `Failing row contains (${ESPIA})`,
      });
      submit.execute.mockRejectedValueOnce(pgErr);
      const m = mk({ params: { reportId: UUID }, body: validBody() });
      await ctrl.put(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(500);
      expect(JSON.stringify(m.json.mock.calls[0][0])).not.toContain(ESPIA);
      const [reported, ctx] = (reportError as jest.Mock).mock.calls[0];
      expect(`${reported.message}|${reported.stack}|${JSON.stringify(ctx)}`).not.toContain(ESPIA);
      expect(reported.message).toBe('db error code=23514 constraint=daily_reports_narrative_len');
      expect(ctx).toMatchObject({ source: 'WorkerDailyReportMeController:put', reportId: UUID });
    });
  });
});
