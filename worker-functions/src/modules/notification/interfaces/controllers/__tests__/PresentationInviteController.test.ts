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
import { PresentationInviteController, MEET_LINK_RE, SCHEDULE_LABEL_DENY, OPT_OUT_CLAUSE_RE } from '../PresentationInviteController';

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = { statusCode: 0, payload: undefined as unknown } as Response & { statusCode: number; payload: unknown };
  res.status = ((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = ((p: unknown) => { res.payload = p; return res; }) as never;
  return res;
}
const req = (o: { params?: Record<string, string>; body?: unknown; query?: Record<string, string>; uid?: string | null }) =>
  ({ params: o.params ?? {}, body: o.body, query: o.query ?? {}, user: o.uid === null ? undefined : { uid: o.uid ?? 'admin-1' } }) as unknown as Request;

const MEET = 'https://meet.google.com/abc-defg-hij';
const T_OK = { body: 'Hola {{worker_name}} {{meet_link}} — respondé BAJA', category: 'UTILITY', is_active: false };
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
    it('SCHEDULE_LABEL_DENY barra termo clínico e identificador numérico', () => {
      expect(SCHEDULE_LABEL_DENY.test('Martes 18:00 (Buenos Aires)')).toBe(false);
      for (const bad of ['paciente Juan', 'Diagnóstico', 'DNI 123', 'CUIL', '12345678']) expect(SCHEDULE_LABEL_DENY.test(bad)).toBe(true);
    });
    it('OPT_OUT_CLAUSE_RE exige a saída expressa', () => {
      expect(OPT_OUT_CLAUSE_RE.test('… respondé BAJA')).toBe(true);
      expect(OPT_OUT_CLAUSE_RE.test('Hola, te invitamos')).toBe(false);
    });
  });

  describe('getSettings', () => {
    it('devolve config + templates com elegibilidade (inativo = INACTIVE, mas escolhível)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ template_slug: 'ar_presentacion_invite', meet_link: MEET, schedule_label: 'x', enabled: true, updated_at: 'd', updated_by: 'Gabi' }] })
        .mockResolvedValueOnce({ rows: [
          { slug: 'ar_presentacion_invite', name: 'p', ...T_OK },
          { slug: 'mkt', name: 'm', body: 'x BAJA', category: 'MARKETING', is_active: true },
          { slug: 'pos', name: 'p', body: 'Hola {{1}} BAJA', category: 'UTILITY', is_active: true },
          { slug: 'nobaja', name: 'n', body: 'Hola {{meet_link}}', category: 'UTILITY', is_active: true },
          { slug: 'ok', name: 'o', body: 'Hola {{meet_link}} BAJA', category: 'UTILITY', is_active: true },
        ] });
      const res = makeRes(); await c.getSettings({} as Request, res);
      expect(res.statusCode).toBe(0); // json direto = 200 implícito
      const d = (res.payload as { data: { templateSlug: string; enabled: boolean; updatedBy: string; templates: Array<{ slug: string; eligible: boolean; reason: string | null }> } }).data;
      expect(d).toMatchObject({ templateSlug: 'ar_presentacion_invite', enabled: true, updatedBy: 'Gabi' });
      expect(d.templates.map((t) => [t.slug, t.eligible, t.reason])).toEqual([
        ['ar_presentacion_invite', false, 'INACTIVE'], ['mkt', false, 'CATEGORY'], ['pos', false, 'PLACEHOLDERS'], ['nobaja', false, 'OPT_OUT_CLAUSE'], ['ok', true, null],
      ]);
    });
    it('sem linha de config → defaults; erro → 500', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const r = makeRes(); await c.getSettings({} as Request, r);
      expect((r.payload as { data: { enabled: boolean; templateSlug: null } }).data).toMatchObject({ enabled: false, templateSlug: null });
      mockQuery.mockRejectedValueOnce('x');
      const r2 = makeRes(); await c.getSettings({} as Request, r2); expect(r2.statusCode).toBe(500);
    });
  });

  describe('updateSettings', () => {
    it('corpo inválido → 400 (strict, link não-Meet, rótulo clínico, enabled sem template)', async () => {
      for (const body of [undefined, {}, { ...GOOD, extra: 1 }, { ...GOOD, meet_link: 'https://zoom.us/1' }, { ...GOOD, schedule_label: 'paciente X' }, { ...GOOD, template_slug: null }]) {
        const r = makeRes(); await c.updateSettings(req({ body }), r); expect(r.statusCode).toBe(400);
      }
      expect(mockConnect).not.toHaveBeenCalled();
    });
    it('template inexistente / MARKETING / posicional / sem BAJA → 400 com motivo', async () => {
      for (const [rows, reason] of [[[], 'NOT_FOUND'], [[{ ...T_OK, category: 'MARKETING' }], 'CATEGORY'], [[{ ...T_OK, body: 'Hola {{1}} BAJA' }], 'PLACEHOLDERS'], [[{ ...T_OK, body: 'Hola {{meet_link}}' }], 'OPT_OUT_CLAUSE']] as const) {
        mockQuery.mockResolvedValueOnce({ rows: [...rows] });
        const r = makeRes(); await c.updateSettings(req({ body: GOOD }), r);
        expect(r.statusCode).toBe(400); expect((r.payload as { details: { reason: string } }).details.reason).toBe(reason);
      }
      expect(mockClientQuery).not.toHaveBeenCalledWith('BEGIN');
      expect(mockRelease).toHaveBeenCalledTimes(4);
    });
    it('feliz: upsert + auditoria com o ator numa transação; desligar sem template não consulta o catálogo', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      const r = makeRes(); await c.updateSettings(req({ body: GOOD }), r);
      expect(r.statusCode).toBe(0); // json direto = 200 implícito
      expect(r.payload).toEqual({ success: true, data: { country: 'AR', templateSlug: GOOD.template_slug, meetLink: MEET, scheduleLabel: 'Martes 18:00', enabled: true } });
      const up = mockClientQuery.mock.calls.find((x) => (x[0] as string).includes('INSERT INTO presentation_invite_settings (')) as [string, unknown[]];
      expect(up[1]).toEqual(['AR', GOOD.template_slug, MEET, 'Martes 18:00', true, 'admin-1']);
      const aud = mockClientQuery.mock.calls.find((x) => (x[0] as string).includes('presentation_invite_settings_audit')) as [string, unknown[]];
      expect(aud[1]).toEqual(['AR', GOOD.template_slug, MEET, 'Martes 18:00', true, 'admin-1']);
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      mockQuery.mockClear();
      const r2 = makeRes(); await c.updateSettings(req({ body: { template_slug: null, meet_link: null, schedule_label: null, enabled: false }, uid: null }), r2);
      expect((r2.payload as { success: boolean }).success).toBe(true); expect(mockQuery).not.toHaveBeenCalled();
    });
    it('erro na transação → ROLLBACK + 500', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      mockClientQuery.mockImplementation(async (sql: string) => { if (sql.includes('INSERT INTO presentation_invite_settings (')) throw new Error('db'); return { rows: [] }; });
      const r = makeRes(); await c.updateSettings(req({ body: GOOD }), r);
      expect(r.statusCode).toBe(500); expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK'); expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('invite', () => {
    it('400 sem source/uuid; 401 sem ator; 202 queued; 200 skipped; 500 em erro', async () => {
      const r1 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: {} }), r1); expect(r1.statusCode).toBe(400);
      const r2 = makeRes(); await c.invite(req({ params: { workerId: 'nope' }, body: { source: 'kanban' } }), r2); expect(r2.statusCode).toBe(400);
      const r3 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban' }, uid: null }), r3); expect(r3.statusCode).toBe(401);
      useCase.execute.mockResolvedValueOnce({ status: 'queued', outboxId: 'o1' });
      const r4 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban', job_posting_id: WID }, uid: 'staff-9' }), r4);
      expect(r4.statusCode).toBe(202);
      expect(useCase.execute).toHaveBeenCalledWith({ workerId: WID, jobPostingId: WID, actorUid: 'staff-9', source: 'kanban' });
      useCase.execute.mockResolvedValueOnce({ status: 'skipped', skipReason: 'OPT_OUT' });
      const r5 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'workers_list' } }), r5);
      expect(r5.statusCode).toBe(200); expect(useCase.execute).toHaveBeenLastCalledWith(expect.objectContaining({ jobPostingId: null }));
      useCase.execute.mockRejectedValueOnce(new Error('x'));
      const r6 = makeRes(); await c.invite(req({ params: { workerId: WID }, body: { source: 'kanban' } }), r6); expect(r6.statusCode).toBe(500);
    });
  });

  describe('last / stats', () => {
    it('last: ids inválidos ignorados, vazio → {}; mapa por worker; erro → 500', async () => {
      const r0 = makeRes(); await c.last(req({ query: { workerIds: 'x,y' } }), r0); expect(r0.payload).toEqual({ success: true, data: {} });
      mockQuery.mockResolvedValueOnce({ rows: [{ worker_id: WID, created_at: 'd', actor: 'Gabi' }] });
      const r = makeRes(); await c.last(req({ query: { workerIds: `${WID},bad` } }), r);
      expect(r.payload).toEqual({ success: true, data: { [WID]: { at: 'd', by: 'Gabi' } } });
      expect(mockQuery.mock.calls[0][1]).toEqual([[WID]]);
      mockQuery.mockRejectedValueOnce(new Error('x'));
      const r2 = makeRes(); await c.last(req({ query: { workerIds: WID } }), r2); expect(r2.statusCode).toBe(500);
    });
    it('stats: contagens 30 d + attended; erro → 500', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'queued', skip_reason: null, source: 'kanban', n: '3' }] }).mockResolvedValueOnce({ rows: [{ n: '0' }] });
      const r = makeRes(); await c.stats({} as Request, r);
      expect(r.payload).toEqual({ success: true, data: { windowDays: 30, rows: [{ status: 'queued', skipReason: null, source: 'kanban', count: 3 }], attended: 0 } });
      mockQuery.mockRejectedValueOnce('x');
      const r2 = makeRes(); await c.stats({} as Request, r2); expect(r2.statusCode).toBe(500);
    });
  });
});
