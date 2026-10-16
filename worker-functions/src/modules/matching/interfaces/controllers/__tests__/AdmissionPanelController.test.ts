/**
 * AdmissionPanelController.test.ts — spec 049 F3: o mapa erro de domínio → HTTP das rotas admin da aba Admissão.
 * Cada tipo de perdedor do reenvio tem o seu teste (pendência da F2): as DUAS exceções E o retorno duplicate_blocked.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn(() => ({ principal: { id: 'staff-uid-1' } })) } }));

import type { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { ResendLimitReached, ResendNotAllowed } from '../../../application/AdmissionMessagingErrors';
import { AppointmentNotCancellableError, AppointmentNotFoundError, ResendInProgressError } from '../../../application/AdmissionPanelErrors';
import type { AdmissionPanelService } from '../../../application/AdmissionPanelService';
import {
  HostNotInRosterError,
  InvalidSlotError,
  PatientNotFoundError,
  SlotInPastError,
  SlotTakenError,
  type AdmissionSchedulingService,
} from '../../../application/AdmissionSchedulingService';
import { TactiqLinkRequiredError } from '../../../application/ports/TactiqPorts';
import { AdmissionPanelController } from '../AdmissionPanelController';

const P = '11111111-1111-1111-1111-111111111111';
const A = '22222222-2222-2222-2222-222222222222';

function res() {
  const r = { statusCode: 0, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, end() { return r; } };
  return r as typeof r & Response;
}
const req = (o: Partial<Request>) => o as Request;

function build() {
  const scheduling = { bookForHost: jest.fn() };
  const panel = { list: jest.fn(), listHosts: jest.fn(), cancel: jest.fn(), resend: jest.fn() };
  const c = new AdmissionPanelController(scheduling as unknown as AdmissionSchedulingService, panel as unknown as AdmissionPanelService);
  return { c, scheduling, panel };
}

describe('POST agendar — a trava do vínculo do Tactiq (spec 049 F4, A4-3)', () => {
  it.each(['missing', 'broken', 'wrong_account'] as const)('responsável %s → 409 TACTIQ_LINK_REQUIRED, sem criar nada', async (state) => {
    const b = build();
    b.scheduling.bookForHost.mockRejectedValue(new TactiqLinkRequiredError(state));
    const r = res();
    await b.c.book(req({ params: { id: P }, body: { hostEmail: 'ana@example.test', slotStartISO: '2030-01-01T10:00:00-03:00' } }), r);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: 'TACTIQ_LINK_REQUIRED' });
  });
});

describe('POST resend — todo perdedor vira 409', () => {
  const call = (b: ReturnType<typeof build>) => {
    const r = res();
    return b.c.resend(req({ params: { id: P, apptId: A, kind: 'confirmation' } }), r).then(() => r);
  };

  it.each([
    ['exceção ResendNotAllowed (entregue / fora da regra)', new ResendNotAllowed('status_delivered'), 'RESEND_NOT_ALLOWED'],
    ['exceção ResendLimitReached (3º reenvio)', new ResendLimitReached('confirmation', 2), 'RESEND_LIMIT_REACHED'],
    ['retorno duplicate_blocked sem exceção (perdeu o claim → ResendInProgressError)', new ResendInProgressError(), 'RESEND_IN_PROGRESS'],
  ])('%s → 409 com code estável', async (_n, err, code) => {
    const b = build();
    b.panel.resend.mockRejectedValue(err);
    const r = await call(b);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ success: false, code });
  });

  it('reenvio feito → 200 com o outcome; o ator vem do token', async () => {
    const b = build();
    b.panel.resend.mockResolvedValue({ outcome: 'sent' });
    const r = await call(b);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ success: true, data: { outcome: 'sent' } });
    expect(b.panel.resend).toHaveBeenCalledWith({ patientId: P, appointmentId: A, kind: 'confirmation', actorUid: 'staff-uid-1' });
  });

  it('kind fora de confirmation|reminder_30min → 400 sem chamar o serviço', async () => {
    const b = build();
    const r = res();
    await b.c.resend(req({ params: { id: P, apptId: A, kind: 'xpto' } }), r);
    expect(r.statusCode).toBe(400);
    expect(b.panel.resend).not.toHaveBeenCalled();
  });
});

describe('POST agendar', () => {
  const book = (b: ReturnType<typeof build>, body: unknown) => {
    const r = res();
    return b.c.book(req({ params: { id: P }, body } as Partial<Request>), r).then(() => r);
  };
  const ok = { hostEmail: 'ana@example.test', slotStartISO: '2026-10-12T14:00:00-03:00' };

  it('201 com o resultado; o ator vem do token', async () => {
    const b = build();
    b.scheduling.bookForHost.mockResolvedValue({ appointmentId: A, admissionCode: 'ADM-ABC234' });
    const r = await book(b, ok);
    expect(r.statusCode).toBe(201);
    expect(b.scheduling.bookForHost).toHaveBeenCalledWith({ patientId: P, ...ok, actorUid: 'staff-uid-1' });
  });

  it.each([
    [new SlotTakenError(), 409, 'SLOT_TAKEN'],
    [new SlotInPastError(), 422, 'SLOT_IN_PAST'],
    [new HostNotInRosterError(), 422, 'HOST_NOT_IN_ROSTER'],
    [new InvalidSlotError(), 400, 'INVALID_SLOT'],
    [new PatientNotFoundError(), 404, 'PATIENT_NOT_FOUND'],
  ])('%s → %s', async (err, status, code) => {
    const b = build();
    b.scheduling.bookForHost.mockRejectedValue(err);
    const r = await book(b, ok);
    expect(r.statusCode).toBe(status);
    expect(r.body).toMatchObject({ code });
  });

  it('corpo com campo a mais (o paciente não escolhe nada) ou sem e-mail válido → 400, serviço não é chamado', async () => {
    const b = build();
    expect((await book(b, { ...ok, country: 'AR' })).statusCode).toBe(400);
    expect((await book(b, { ...ok, hostEmail: 'nao-e-email' })).statusCode).toBe(400);
    expect(b.scheduling.bookForHost).not.toHaveBeenCalled();
  });

  it('erro inesperado → 500 genérico, SEM a mensagem do erro, relatado só com o id do paciente', async () => {
    const b = build();
    b.scheduling.bookForHost.mockRejectedValue(new Error('falha para carla@example.test'));
    const r = await book(b, ok);
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('carla@example.test');
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdmissionPanelController:book', patientId: P });
  });
});

describe('cancelar, listar, hosts', () => {
  it('cancelar: reunião inexistente → 404; já cancelada → 409; ok → 200', async () => {
    const b = build();
    const run = async () => { const r = res(); await b.c.cancel(req({ params: { id: P, apptId: A } }), r); return r; };
    b.panel.cancel.mockRejectedValueOnce(new AppointmentNotFoundError());
    expect((await run()).statusCode).toBe(404);
    b.panel.cancel.mockRejectedValueOnce(new AppointmentNotCancellableError('cancelled'));
    expect((await run()).statusCode).toBe(409);
    b.panel.cancel.mockResolvedValueOnce({ status: 'cancelled' });
    expect((await run()).statusCode).toBe(200);
  });

  it('listar: paciente de outro país → 404; id que não é UUID → 400', async () => {
    const b = build();
    b.panel.list.mockRejectedValue(new PatientNotFoundError());
    const r = res();
    await b.c.list(req({ params: { id: P } }), r);
    expect(r.statusCode).toBe(404);
    const r2 = res();
    await b.c.list(req({ params: { id: 'nao-uuid' } }), r2);
    expect(r2.statusCode).toBe(400);
  });

  it('hosts: país inválido → 400; válido → só e-mail e nome do roster', async () => {
    const b = build();
    const bad = res();
    await b.c.listHosts(req({ query: { country: 'XX' } }), bad);
    expect(bad.statusCode).toBe(400);
    b.panel.listHosts.mockResolvedValue([
      { email: 'ana@example.test', displayName: 'Ana', linked: true, linkState: 'linked' },
      { email: 'mari@example.test', displayName: 'Mari', linked: false, linkState: 'broken' },
    ]);
    const r = res();
    await b.c.listHosts(req({ query: { country: 'AR' } }), r);
    expect(r.body).toEqual({ success: true, data: [
      { email: 'ana@example.test', displayName: 'Ana', linked: true, linkState: 'linked' },
      { email: 'mari@example.test', displayName: 'Mari', linked: false, linkState: 'broken' },
    ] });
  });

  it('sem ator identificado → 401 (não 500)', async () => {
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const b = build();
    const r = res();
    await b.c.cancel(req({ params: { id: P, apptId: A } }), r);
    expect(r.statusCode).toBe(401);
    expect(b.panel.cancel).not.toHaveBeenCalled();
  });
});
