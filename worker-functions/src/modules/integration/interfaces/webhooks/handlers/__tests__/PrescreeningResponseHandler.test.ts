/**
 * PrescreeningResponseHandler.test.ts — T-095-21 (spec 095 §3.2): o handler é só o ACK.
 *
 * Guarda na inbox, publica o inboxId e responde 200; NÃO executa o caso de uso.
 *  (a) insertReceived lança → 503 (nunca 500) + reportError sem PII;
 *  (b) ProcessTalentumPrescreening não é chamado no ack (espião);
 *  (c) publish lança → 200 + reportError.
 * Inbox e publisher são dublês; dados sintéticos; PII nunca aparece em log nem em reportError.
 */
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: jest.fn(),
}));

import { PrescreeningResponseHandler, parseAck } from '../PrescreeningResponseHandler';
import { ProcessTalentumPrescreening } from '@modules/matching';
import { computeBodyHash } from '../../../../domain/TalentumInbox';
import type { TalentumWebhookContext } from '../TalentumWebhookHandler';

const SENSITIVE_EMAIL = 'candidata.sensivel@example.com';
const SENSITIVE_PHONE = '+5491100001111';

function makeBody(subtype = 'ANALYZED') {
  return {
    action: 'PRESCREENING_RESPONSE',
    subtype,
    data: {
      prescreening: { id: 'tp-1', name: 'Case Test' },
      profile: { id: 'prof-1', firstName: 'Juan', lastName: 'Perez', email: SENSITIVE_EMAIL, phoneNumber: SENSITIVE_PHONE, registerQuestions: [] },
      response: { id: 'resp-1', state: [], score: 85, statusLabel: 'QUALIFIED' },
    },
  };
}

function fakeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

function makeDeps() {
  const inbox = { insertReceived: jest.fn().mockResolvedValue({ id: 'inbox-1', duplicate: false }) };
  const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
  const handler = new PrescreeningResponseHandler(inbox as never, publisher as never);
  return { inbox, publisher, handler };
}

const ctx: TalentumWebhookContext = { environment: 'production', partnerId: 'partner-1', ingressHost: 'api.example.test' };
const reportErrorMock = () => (jest.requireMock('@shared/logging') as { reportError: jest.Mock }).reportError;

describe('PrescreeningResponseHandler — ack', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    reportErrorMock().mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errSpy = jest.spyOn(console, 'error').mockImplementation();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('guarda na inbox (hash, ids, ambiente, host, corpo), publica o inboxId e responde 200 { received: true }', async () => {
    const { inbox, publisher, handler } = makeDeps();
    const res = fakeRes();
    const body = makeBody();

    await handler.handle(body, ctx, res);

    expect(inbox.insertReceived).toHaveBeenCalledWith({
      bodyHash: computeBodyHash(body),
      action: 'PRESCREENING_RESPONSE',
      subtype: 'ANALYZED',
      statusLabel: 'QUALIFIED',
      prescreeningId: 'tp-1',
      profileId: 'prof-1',
      environment: 'production',
      ingressHost: 'api.example.test',
      payload: body,
    });
    expect(publisher.publish).toHaveBeenCalledWith('inbox-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('(a) insertReceived lança → 503 { error: "retry" } (nunca 500), sem publish, reportError sem PII', async () => {
    const { inbox, publisher, handler } = makeDeps();
    inbox.insertReceived.mockRejectedValue(
      Object.assign(new Error(`invalid input syntax: "${SENSITIVE_EMAIL}"`), { code: '22P02', constraint: 'x', detail: `Key (email)=(${SENSITIVE_EMAIL})` }),
    );
    const res = fakeRes();

    await handler.handle(makeBody(), ctx, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'retry' });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(reportErrorMock()).toHaveBeenCalledTimes(1);
    const [err, rctx] = reportErrorMock().mock.calls[0];
    expect(rctx).toEqual({ source: 'PrescreeningResponseHandler:ack-insert', talentumPrescreeningId: 'tp-1' });
    expect(JSON.stringify([err.message, err.stack, rctx])).not.toContain('candidata.sensivel');
  });

  it('(b) o caso de uso ProcessTalentumPrescreening NÃO é chamado no ack', async () => {
    const execSpy = jest.spyOn(ProcessTalentumPrescreening.prototype, 'execute').mockRejectedValue(new Error('não devia ser chamado'));
    const { handler } = makeDeps();

    await handler.handle(makeBody(), ctx, fakeRes());

    expect(execSpy).not.toHaveBeenCalled();
    execSpy.mockRestore();
  });

  it('(c) publish lança → 200 mesmo assim + reportError (a linha fica RECEIVED)', async () => {
    const { publisher, handler } = makeDeps();
    publisher.publish.mockRejectedValue(new Error('pubsub down'));
    const res = fakeRes();

    await handler.handle(makeBody(), ctx, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(reportErrorMock()).toHaveBeenCalledTimes(1);
    expect(reportErrorMock().mock.calls[0][1]).toEqual({ source: 'PrescreeningResponseHandler:ack-publish', inboxId: 'inbox-1' });
  });

  it('duplicado (mesmo corpo) → 200 e o log diz duplicate=true', async () => {
    const { inbox, handler } = makeDeps();
    inbox.insertReceived.mockResolvedValue({ id: 'inbox-0', duplicate: true });
    const res = fakeRes();

    await handler.handle(makeBody(), ctx, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('duplicate=true');
  });

  it('PII guard: o log do ack tem só inboxId/subtype/ingress_host/duplicate, nunca e-mail, telefone ou nome', async () => {
    const { handler } = makeDeps();

    await handler.handle(makeBody(), ctx, fakeRes());

    const lines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).toContain('inboxId=inbox-1');
    expect(lines).toContain('subtype=ANALYZED');
    expect(lines).toContain('ingress_host=api.example.test');
    expect(lines).toContain('duplicate=false');
    expect(lines).not.toContain(SENSITIVE_EMAIL);
    expect(lines).not.toContain(SENSITIVE_PHONE);
    expect(lines).not.toContain('Juan');
    expect(lines).not.toContain('INCOMING');
  });

  it('corpo sem o mínimo → 400 e nada é gravado nem publicado', async () => {
    const { inbox, publisher, handler } = makeDeps();
    const res = fakeRes();
    const body = makeBody();
    (body.data.profile as { id: string }).id = '';

    await handler.handle(body, ctx, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(inbox.insertReceived).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

describe('parseAck — validação mínima do ack', () => {
  it('PRESCREENING_RESPONSE exige prescreening.id e profile.id', () => {
    expect(parseAck(makeBody())).toEqual({ action: 'PRESCREENING_RESPONSE', subtype: 'ANALYZED', statusLabel: 'QUALIFIED', prescreeningId: 'tp-1', profileId: 'prof-1' });
    expect(parseAck({ action: 'PRESCREENING_RESPONSE', data: { prescreening: { id: 'x' } } })).toBeNull();
    expect(parseAck({ action: 'PRESCREENING_RESPONSE', data: { prescreening: { id: '  ' }, profile: { id: 'p' } } })).toBeNull();
  });

  it('PRESCREENING exige data._id', () => {
    expect(parseAck({ action: 'PRESCREENING', subtype: 'CREATED', data: { _id: 'proj-1' } })).toMatchObject({ prescreeningId: 'proj-1', profileId: null });
    expect(parseAck({ action: 'PRESCREENING', data: {} })).toBeNull();
  });

  it('action ausente / não-string → null; action desconhecida é guardada (vira UNSUPPORTED no processador)', () => {
    expect(parseAck(null)).toBeNull();
    expect(parseAck({})).toBeNull();
    expect(parseAck({ action: 7 })).toBeNull();
    expect(parseAck({ action: 'OUTRA' })).toMatchObject({ action: 'OUTRA', prescreeningId: null });
  });
});
