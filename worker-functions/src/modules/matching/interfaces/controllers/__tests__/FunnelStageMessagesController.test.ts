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
import { FunnelStageMessagesController } from '../FunnelStageMessagesController';

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = { statusCode: 0, payload: undefined as unknown } as Response & { statusCode: number; payload: unknown };
  res.status = ((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = ((p: unknown) => { res.payload = p; return res; }) as never;
  return res;
}
const req = (stage: string, body?: unknown, uid = 'admin-1') => ({ params: { stage }, body, user: { uid } }) as unknown as Request;

const T_OK = { slug: 'qualified_reprogram_confirm', name: 'Reprogramar', body: 'Caso {{case_number}}', category: 'UTILITY', is_active: true };
const T_MKT = { slug: 'ar_invite_open', name: 'Invite', body: 'x', category: 'MARKETING', is_active: true };
const T_DENY = { slug: 'complete_register_utility_v2', name: 'Cobrança', body: 'x', category: 'UTILITY', is_active: true };

describe('FunnelStageMessagesController', () => {
  let c: FunnelStageMessagesController;
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockClientQuery.mockResolvedValue({ rows: [] });
    c = new FunnelStageMessagesController();
  });

  describe('list', () => {
    it('devolve as 9 etapas (AR) com a config e os templates com elegibilidade explicada', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ stage: 'COMPLETED', template_slug: 'qualified_reprogram_confirm', enabled: true, channel: 'whatsapp', builtin: null, updated_by: 'u1', updated_at: '2026-08-29', updated_by_name: 'Gabi' }, { stage: 'QUALIFIED', template_slug: null, enabled: false, channel: 'whatsapp', builtin: 'interview_invite', updated_by: null, updated_at: null, updated_by_name: null }] })
        .mockResolvedValueOnce({ rows: [T_OK, T_MKT, T_DENY, { slug: 'x_pos', name: 'p', body: 'Hola {{1}}', category: 'UTILITY', is_active: true }] });
      const res = makeRes();
      await c.list({} as Request, res);
      expect(res.statusCode).toBe(200);
      const data = (res.payload as { data: { country: string; stages: Array<Record<string, unknown>>; templates: Array<Record<string, unknown>> } }).data;
      expect(data.country).toBe('AR');
      expect(data.stages).toHaveLength(9);
      expect(data.stages.find((s) => s.stage === 'COMPLETED')).toEqual({ stage: 'COMPLETED', templateSlug: 'qualified_reprogram_confirm', enabled: true, channel: 'whatsapp', builtin: null, updatedBy: 'Gabi', updatedAt: '2026-08-29' });
      expect(data.stages.find((s) => s.stage === 'QUALIFIED')).toMatchObject({ builtin: 'interview_invite', enabled: false });
      expect(data.stages.find((s) => s.stage === 'INVITED')).toMatchObject({ templateSlug: null, enabled: false, updatedBy: null });
      expect(data.templates.map((t) => [t.slug, t.eligible, t.reason])).toEqual([
        ['qualified_reprogram_confirm', true, null], ['ar_invite_open', false, 'CATEGORY'], ['complete_register_utility_v2', false, 'DENY_LIST'], ['x_pos', false, 'PLACEHOLDERS'],
      ]);
      expect(mockQuery.mock.calls[0][1]).toEqual(['AR']);
    });
    it('erro → 500', async () => {
      mockQuery.mockRejectedValueOnce(new Error('x'));
      const res = makeRes();
      await c.list({} as Request, res);
      expect(res.statusCode).toBe(500);
      mockQuery.mockRejectedValueOnce('y');
      await c.list({} as Request, makeRes());
      expect(mockReportError).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    it('etapa desconhecida → 400; QUALIFIED → 409 (built-in)', async () => {
      const r1 = makeRes(); await c.update(req('FOO', { template_slug: null, enabled: false }), r1); expect(r1.statusCode).toBe(400);
      const r2 = makeRes(); await c.update(req('qualified', { template_slug: null, enabled: false }), r2); expect(r2.statusCode).toBe(409);
      // sem :stage nenhum (rota mal montada) → 400, nunca 500
      const r3 = makeRes(); await c.update({ params: {}, body: {} } as unknown as Request, r3); expect(r3.statusCode).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });
    it('corpo inválido → 400 (strict; enabled sem template)', async () => {
      for (const body of [undefined, {}, { template_slug: 'x', enabled: true, extra: 1 }, { template_slug: null, enabled: true }]) {
        const r = makeRes(); await c.update(req('COMPLETED', body), r); expect(r.statusCode).toBe(400);
      }
    });
    it('template inexistente/inativo → 400; MARKETING → 400 CATEGORY; deny-list → 400 DENY_LIST', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const r1 = makeRes(); await c.update(req('COMPLETED', { template_slug: 'nope', enabled: true }), r1); expect(r1.statusCode).toBe(400);
      mockQuery.mockResolvedValueOnce({ rows: [T_MKT] });
      const r2 = makeRes(); await c.update(req('COMPLETED', { template_slug: T_MKT.slug, enabled: true }), r2);
      expect(r2.statusCode).toBe(400); expect((r2.payload as { details: { reason: string } }).details.reason).toBe('CATEGORY');
      mockQuery.mockResolvedValueOnce({ rows: [T_DENY] });
      const r3 = makeRes(); await c.update(req('INVITED', { template_slug: T_DENY.slug, enabled: true }), r3);
      expect((r3.payload as { details: { reason: string } }).details.reason).toBe('DENY_LIST');
      expect(mockConnect).not.toHaveBeenCalled();
    });
    it('feliz: grava (AR, etapa), audita com o ator, numa transação; template null desliga', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      const r = makeRes();
      await c.update(req('completed', { template_slug: T_OK.slug, enabled: true }), r);
      expect(r.statusCode).toBe(200);
      expect(r.payload).toEqual({ success: true, data: { country: 'AR', stage: 'COMPLETED', templateSlug: T_OK.slug, enabled: true } });
      const upd = mockClientQuery.mock.calls.find((x) => (x[0] as string).includes('UPDATE funnel_stage_messages')) as [string, unknown[]];
      expect(upd[1]).toEqual(['AR', 'COMPLETED', T_OK.slug, true, 'admin-1']);
      const aud = mockClientQuery.mock.calls.find((x) => (x[0] as string).includes('INSERT INTO funnel_stage_messages_audit')) as [string, unknown[]];
      expect(aud[1]).toEqual(['AR', 'COMPLETED', T_OK.slug, true, 'admin-1']);
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockRelease).toHaveBeenCalled();
      // desligar sem template: sem consulta ao template
      mockQuery.mockClear();
      const r2 = makeRes();
      await c.update({ params: { stage: 'INVITED' }, body: { template_slug: null, enabled: false } } as unknown as Request, r2);
      expect(r2.statusCode).toBe(200);
      expect(mockQuery).not.toHaveBeenCalled();
      const aud2 = mockClientQuery.mock.calls.filter((x) => (x[0] as string).includes('INSERT INTO funnel_stage_messages_audit')).pop() as [string, unknown[]];
      expect(aud2[1]).toEqual(['AR', 'INVITED', null, false, null]);
    });
    it('erro na transação → ROLLBACK + 500; erro não-Error → 500', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [T_OK] });
      mockClientQuery.mockImplementation(async (sql: string) => { if (sql.includes('UPDATE')) throw new Error('db'); return { rows: [] }; });
      const r = makeRes(); await c.update(req('COMPLETED', { template_slug: T_OK.slug, enabled: true }), r);
      expect(r.statusCode).toBe(500); expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK'); expect(mockRelease).toHaveBeenCalled();
      mockQuery.mockRejectedValueOnce('boom');
      const r2 = makeRes(); await c.update(req('COMPLETED', { template_slug: T_OK.slug, enabled: true }), r2);
      expect(r2.statusCode).toBe(500);
    });
  });
});
