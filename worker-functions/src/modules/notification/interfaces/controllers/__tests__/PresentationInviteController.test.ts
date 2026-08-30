const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockReportError = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery, connect: mockConnect }) }) },
}));
jest.mock('@shared/logging', () => ({ reportError: (...a: unknown[]) => mockReportError(...a) }));

import { Request, Response } from 'express';
import { PresentationInviteController, MEET_LINK_RE, deniedScheduleLabelTerm } from '../PresentationInviteController';
import { OPT_OUT_CLAUSE_RE } from '../../../application/InvitePresentationMeetingUseCase';

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = { statusCode: 0, payload: undefined as unknown } as Response & { statusCode: number; payload: unknown };
  res.status = ((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = ((p: unknown) => { res.payload = p; return res; }) as never;
  return res;
}
const req = (o: { params?: Record<string, string>; body?: unknown; query?: Record<string, string>; uid?: string | null }) =>
  ({ params: o.params ?? {}, body: o.body, query: o.query ?? {}, user: o.uid === null ? undefined : { uid: o.uid ?? 'admin-1' } }) as unknown as Request;
const details = (r: { payload: unknown }) => (r.payload as { details: { reason: string; term?: string } }).details;

const MEET = 'https://meet.google.com/abc-defg-hij';
const T_OK = { body: 'Hola {{worker_name}} {{meet_link}} — respondé BAJA', category: 'UTILITY', is_active: false };
const T_SCHED = { ...T_OK, body: 'Hola {{worker_name}} {{schedule_label}} {{meet_link}} — respondé BAJA' };
const GOOD = { template_slug: 'ar_presentacion_invite', meet_link: MEET, schedule_label: 'Martes 18:00', enabled: true };
const WID = '11111111-2222-4333-8444-555555555555';

describe('PresentationInviteController', () => {
  let c: PresentationInviteController; let useCase: { execute: jest.Mock };
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockClientQuery.mockResolvedValue({ rows: [] });
    useCase = { execute: jest.fn() };
    c = new PresentationInviteController(useCase as never);
  });

  describe('réguas do lex (C3/C4)', () => {
    it('MEET_LINK_RE só aceita sala do Google Meet', () => {
      expect(MEET_LINK_RE.test(MEET)).toBe(true);
      for (const bad of ['https://zoom.us/j/1', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij?x=1', 'https://meet.google.com/']) expect(MEET_LINK_RE.test(bad)).toBe(false);
    });
    it('deniedScheduleLabelTerm: termo curto só como PALAVRA (cid ≠ decidir, dni ≠ sydni); radical clínico por prefixo; 6+ dígitos', () => {
      for (const ok of ['Martes 18:00 (Buenos Aires)', 'Vamos a decidir el martes', 'Con Sydni a las 18', 'Sala 12345', 'Ácido cítrico']) expect(deniedScheduleLabelTerm(ok)).toBeNull();
      expect(deniedScheduleLabelTerm('paciente Juan')).toBe('paciente');
      expect(deniedScheduleLabelTerm('Diagnóstico')).toBe('diagn');
      expect(deniedScheduleLabelTerm('Martes, medicación del paciente')).toBe('paciente'); // 1º termo da lista que casa
      expect(deniedScheduleLabelTerm('Martes, medicación')).toBe('medicaci');
      expect(deniedScheduleLabelTerm('Patología')).toBe('patolog');
      expect(deniedScheduleLabelTerm('DNI 123')).toBe('dni');
      expect(deniedScheduleLabelTerm('cid')).toBe('cid');
      expect(deniedScheduleLabelTerm('(CUIL)')).toBe('cuil');
      expect(deniedScheduleLabelTerm('doença!')).toBe('doença');
      expect(deniedScheduleLabelTerm('12345678')).toBe('6+ dígitos');
    });
    it('OPT_OUT_CLAUSE_RE exige a saída expressa', () => {
      expect(OPT_OUT_CLAUSE_RE.test('… respondé BAJA')).toBe(true);
      expect(OPT_OUT_CLAUSE_RE.test('Hola, te invitamos')).toBe(false);
    });
  });

  describe('getSettings', () => {
    it('devolve config + templates com elegibilidade (inativo = INACTIVE, mas escolhível; corpo null = sem BAJA)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'ar_presentacion_invite', meet_link: MEET, schedule_label: 'x', enabled: true, updated_at: 'd', updated_by: 'Gabi' }] })
        .mockResolvedValueOnce({ rows: [
          { slug: 'ar_presentacion_invite', name: 'p', ...T_OK },
          { slug: 'mkt', name: 'm', body: 'x BAJA', category: 'MARKETING', is_active: true },
          { slug: 'pos', name: 'p', body: 'Hola {{1}} BAJA', category: 'UTILITY', is_active: true },
          { slug: 'nobaja', name: 'n', body: 'Hola {{meet_link}}', category: 'UTILITY', is_active: true },
          { slug: 'nobody', name: 'n', body: null, category: 'UTILITY', is_active: true },
          { slug: 'ok', name: 'o', body: 'Hola {{meet_link}} BAJA', category: 'UTILITY', is_active: true },
        ] });
      const res = makeRes(); await c.getSettings({} as Request, res);
      expect(res.statusCode).toBe(0); // json direto = 200 implícito
      const d = (res.payload as { data: { templateSlug: string; enabled: boolean; updatedBy: string; templates: Array<{ slug: string; eligible: boolean; reason: string | null }> } }).data;
      expect(d).toMatchObject({ templateSlug: 'ar_presentacion_invite', enabled: true, updatedBy: 'Gabi' });
      expect(d.templates.map((t) => [t.slug, t.eligible, t.reason])).toEqual([
        ['ar_presentacion_invite', false, 'INACTIVE'], ['mkt', false, 'CATEGORY'], ['pos', false, 'PLACEHOLDERS'], ['nobaja', false, 'OPT_OUT_CLAUSE'], ['nobody', false, 'OPT_OUT_CLAUSE'], ['ok', true, null],
      ]);
    });
    it('sem linha de config → defaults; erro (Error e não-Error) → 500 reportado', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const r = makeRes(); await c.getSettings({} as Request, r);
      expect((r.payload as { data: { enabled: boolean; templateSlug: null } }).data).toMatchObject({ enabled: false, templateSlug: null });
      mockQuery.mockRejectedValueOnce('x');
      const r2 = makeRes(); await c.getSettings({} as Request, r2); expect(r2.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('x'), expect.objectContaining({ source: 'PresentationInviteController:getSettings' }));
      mockQuery.mockRejectedValueOnce(new Error('db'));
      const r3 = makeRes(); await c.getSettings({} as Request, r3); expect(r3.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('db'), expect.anything());
    });
  });

  describe('updateSettings', () => {
    it('corpo inválido → 400 (strict, link não-Meet, enabled sem template); nada de conexão nem catálogo', async () => {
      for (const body of [undefined, {}, { ...GOOD, extra: 1 }, { ...GOOD, meet_link: 'https://zoom.us/1' }, { ...GOOD, template_slug: null }]) {
        const r = makeRes(); await c.updateSettings(req({ body }), r); expect(r.statusCode).toBe(400);
      }
      expect(mockConnect).not.toHaveBeenCalled(); expect(mockQuery).not.toHaveBeenCalled();
    });
    it('rótulo com termo negado → 400 dizendo QUAL termo (C4), antes de consultar o catálogo', async () => {
      const r = makeRes(); await c.updateSettings(req({ body: { ...GOOD, schedule_label: 'Martes, medicación del paciente' } }), r);
      expect(r.statusCode).toBe(400); expect(details(r)).toEqual({ reason: 'SCHEDULE_LABEL_DENIED', term: 'paciente' });
      expect(mockQuery).not.toHaveBeenCalled(); expect(mockConnect).not.toHaveBeenCalled();
    });
    it('template inexistente / MARKETING / posicional / sem BAJA → 400 com motivo, SEM abrir conexão (pool.connect só depois de validar)', async () => {
      for (const [rows, reason] of [[[], 'NOT_FOUND'], [[{ ...T_OK, category: 'MARKETING' }], 'CATEGORY'], [[{ ...T_OK, body: 'Hola {{1}} BAJA' }], 'PLACEHOLDERS'], [[{ ...T_OK, body: 'Hola {{meet_link}}' }], 'OPT_OUT_CLAUSE']] as const) {
        mockQuery.mockResolvedValueOnce({ rows: [...rows] });
        const r = makeRes(); await c.updateSettings(req({ body: GOOD }), r);
        expect(r.statusCode).toBe(400); expect(details(r).reason).toBe(reason);
      }
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockClientQuery).not.toHaveBeenCalled();
    });
    it('template com {{schedule_label}} + enabled + rótulo vazio/null/só espaços → 400 SCHEDULE_LABEL_REQUIRED; desligado ou template sem a variável passa', async () => {
      for (const schedule_label of [null, '', '   ']) {
        mockQuery.mockResolvedValueOnce({ rows: [T_SCHED] });
        const r = makeRes(); await c.updateSettings(req({ body: { ...GOOD, schedule_label } }), r);
        expect(r.statusCode).toBe(400); expect(details(r).reason).toBe('SCHEDULE_LABEL_REQUIRED');
      }
      expect(mockConnect).not.toHaveBeenCalled();
      mockQuery.mockResolvedValueOnce({ rows: [T_SCHED] });
      const off = makeRes(); await c.updateSettings(req({ body: { ...GOOD, schedule_label: null, enabled: false } }), off);
      expect((off.payload as { success: boolean }).success).toBe(true);
      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      const noVar = makeRes(); await c.updateSettings(req({ body: { ...GOOD, schedule_label: null } }), noVar);
      expect((noVar.payload as { success: boolean }).success).toBe(true);
    });
    it('feliz: upsert + auditoria com o ator numa transação; desligar sem template não consulta o catálogo', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [T_SCHED] });
      const r = makeRes(); await c.updateSettings(req({ body: GOOD }), r);
      expect(r.statusCode).toBe(0); // json direto = 200 implícito
      expect(r.payload).toEqual({ success: true, data: { country: 'AR', templateSlug: GOOD.template_slug, meetLink: MEET, scheduleLabel: 'Martes 18:00', enabled: true } });
      const up = mockClientQuery.mock.calls.find((x) => (x[0] as string).includes('INSERT INTO presentation_invite_settings (')) as [string, unknown[]];
      expect(up[1]).toEqual(['AR', GOOD.template_slug, MEET, 'Martes 18:00', true, 'admin-1']);
      const aud = mockClientQuery.mock.calls.find((x) => (x[0] as string).includes('presentation_invite_settings_audit')) as [string, unknown[]];
      expect(aud[1]).toEqual(['AR', GOOD.template_slug, MEET, 'Martes 18:00', true, 'admin-1']);
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockRelease).toHaveBeenCalledTimes(1);
      mockQuery.mockClear();
      const r2 = makeRes(); await c.updateSettings(req({ body: { template_slug: null, meet_link: null, schedule_label: null, enabled: false }, uid: null }), r2);
      expect((r2.payload as { success: boolean }).success).toBe(true); expect(mockQuery).not.toHaveBeenCalled();
    });
    it('erro na transação → ROLLBACK + release + 500; ROLLBACK que também falha não esconde o erro original; catálogo fora do ar → 500 sem conexão', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      mockClientQuery.mockImplementation(async (sql: string) => { if (sql.includes('INSERT INTO presentation_invite_settings (')) throw new Error('db'); return { rows: [] }; });
      const r = makeRes(); await c.updateSettings(req({ body: GOOD }), r);
      expect(r.statusCode).toBe(500); expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK'); expect(mockRelease).toHaveBeenCalled();
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('db'), expect.objectContaining({ source: 'PresentationInviteController:updateSettings' }));

      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      mockClientQuery.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('rollback too'); if (sql === 'COMMIT') throw 'commit failed'; return { rows: [] }; });
      const r2 = makeRes(); await c.updateSettings(req({ body: GOOD }), r2);
      expect(r2.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('commit failed'), expect.anything());

      mockQuery.mockRejectedValueOnce(new Error('catalog down'));
      const r3 = makeRes(); await c.updateSettings(req({ body: GOOD }), r3);
      expect(r3.statusCode).toBe(500); expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('invite', () => {
    it('400 sem source/uuid (inclusive "------" e request sem params/body); 401 sem ator; 202 queued; 200 skipped; 500 em erro (Error e não-Error)', async () => {
      const r1 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: {} }), r1); expect(r1.statusCode).toBe(400);
      for (const workerId of ['nope', '------------------------------------', `${WID}x`]) {
        const r = makeRes(); await c.invite(req({ params: { workerId }, body: { source: 'kanban' } }), r); expect(r.statusCode).toBe(400);
      }
      const r0 = makeRes(); await c.invite(req({ body: { source: 'kanban' } }), r0); expect(r0.statusCode).toBe(400);
      const rNo = makeRes(); await c.invite({ user: { uid: 'u' } } as unknown as Request, rNo); expect(rNo.statusCode).toBe(400);
      const r3 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban' }, uid: null }), r3); expect(r3.statusCode).toBe(401);
      expect(useCase.execute).not.toHaveBeenCalled();
      useCase.execute.mockResolvedValueOnce({ status: 'queued', outboxId: 'o1' });
      const r4 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban', job_posting_id: WID }, uid: 'staff-9' }), r4);
      expect(r4.statusCode).toBe(202);
      expect(useCase.execute).toHaveBeenCalledWith({ workerId: WID, jobPostingId: WID, actorUid: 'staff-9', source: 'kanban' });
      useCase.execute.mockResolvedValueOnce({ status: 'skipped', skipReason: 'OPT_OUT' });
      const r5 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'workers_list' } }), r5);
      expect(r5.statusCode).toBe(200); expect(useCase.execute).toHaveBeenLastCalledWith(expect.objectContaining({ jobPostingId: null }));
      useCase.execute.mockRejectedValueOnce(new Error('x'));
      const r6 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban' } }), r6); expect(r6.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('x'), expect.objectContaining({ source: 'PresentationInviteController:invite', workerId: WID }));
      useCase.execute.mockRejectedValueOnce('str');
      const r7 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban' } }), r7); expect(r7.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('str'), expect.anything());
    });
  });

  describe('last / stats', () => {
    it('last: ids inválidos ignorados ("------" incluso), sem query/vazio → {}; mapa por worker; erro (Error e não-Error) → 500', async () => {
      const r0 = makeRes(); await c.last(req({ query: { workerIds: 'x,------------------------------------' } }), r0); expect(r0.payload).toEqual({ success: true, data: {} });
      const rNoQ = makeRes(); await c.last({} as Request, rNoQ); expect(rNoQ.payload).toEqual({ success: true, data: {} });
      const rEmpty = makeRes(); await c.last(req({ query: {} }), rEmpty); expect(rEmpty.payload).toEqual({ success: true, data: {} });
      expect(mockQuery).not.toHaveBeenCalled();
      mockQuery.mockResolvedValueOnce({ rows: [{ worker_id: WID, created_at: 'd', actor: 'Gabi' }] });
      const r = makeRes(); await c.last(req({ query: { workerIds: ` ${WID} ,bad` } }), r);
      expect(r.payload).toEqual({ success: true, data: { [WID]: { at: 'd', by: 'Gabi' } } });
      expect(mockQuery.mock.calls[0][1]).toEqual([[WID]]);
      mockQuery.mockRejectedValueOnce(new Error('x'));
      const r2 = makeRes(); await c.last(req({ query: { workerIds: WID } }), r2); expect(r2.statusCode).toBe(500);
      mockQuery.mockRejectedValueOnce('y');
      const r3 = makeRes(); await c.last(req({ query: { workerIds: WID } }), r3); expect(r3.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('y'), expect.objectContaining({ source: 'PresentationInviteController:last' }));
    });
    it('stats: contagens 30 d + attended (0 quando a contagem não volta); erro (Error e não-Error) → 500', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'queued', skip_reason: null, source: 'kanban', n: '3' }] }).mockResolvedValueOnce({ rows: [{ n: '2' }] });
      const r = makeRes(); await c.stats({} as Request, r);
      expect(r.payload).toEqual({ success: true, data: { windowDays: 30, rows: [{ status: 'queued', skipReason: null, source: 'kanban', count: 3 }], attended: 2 } });
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const rZero = makeRes(); await c.stats({} as Request, rZero);
      expect((rZero.payload as { data: { attended: number; rows: unknown[] } }).data).toEqual({ windowDays: 30, rows: [], attended: 0 });
      mockQuery.mockRejectedValueOnce('x');
      const r2 = makeRes(); await c.stats({} as Request, r2); expect(r2.statusCode).toBe(500);
      mockQuery.mockRejectedValueOnce(new Error('e'));
      const r3 = makeRes(); await c.stats({} as Request, r3); expect(r3.statusCode).toBe(500);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error('e'), expect.objectContaining({ source: 'PresentationInviteController:stats' }));
    });
  });
});
