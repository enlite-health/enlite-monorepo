/**
 * TalentumWebhookController.test.ts — T-095-21 (spec 095 §3.2): o controller só dá o ACK.
 *
 * Cobre: validação mínima (400), PRESCREENING e PRESCREENING_RESPONSE vão para a inbox, propagação de
 * environment e de ingress_host (X-Forwarded-Host > Host), 503 quando o INSERT falha, 200 quando o publish
 * falha, e que o caso de uso NÃO roda no ack. O Zod completo e o roteamento por action saíram do ack
 * (vão para o processador, T-095-30/32); os e2e que dependiam do processamento síncrono migram no T-095-24.
 * Inbox e publisher são dublês; dados sintéticos.
 */
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: jest.fn(),
}));

import { Request, Response } from 'express';
import { TalentumWebhookController } from '../TalentumWebhookController';
import { ProcessTalentumPrescreening } from '@modules/matching';
import { CreateJobPostingFromTalentumUseCase } from '../../../../application/CreateJobPostingFromTalentumUseCase';

function makeResponsePayload(overrides: Record<string, any> = {}) {
  return {
    action: 'PRESCREENING_RESPONSE' as const,
    subtype: overrides.subtype ?? 'INITIATED',
    data: {
      prescreening: { id: 'tp-001', name: 'Test Case', ...(overrides.prescreening || {}) },
      profile: {
        id: 'prof-001', firstName: 'Test', lastName: 'User', email: 'test@example.com', phoneNumber: '+5491100000000',
        registerQuestions: [], ...(overrides.profile || {}),
      },
      response: { id: 'resp-001', state: [], ...(overrides.response || {}) },
    },
  };
}

function makeCreatedPayload(_id = 'talentum-project-001') {
  return { action: 'PRESCREENING' as const, subtype: 'CREATED' as const, data: { _id, name: 'Operario de producción' } };
}

function makeMockReq(body: any, partnerContext?: any, headers: Record<string, any> = {}): Partial<Request> {
  const req: Partial<Request> = { body, headers };
  if (partnerContext !== undefined) (req as any).partnerContext = partnerContext;
  return req;
}

function makeMockRes() {
  let statusCode: number | null = null;
  let body: any = null;
  const res: Partial<Response> = {
    status: jest.fn().mockImplementation((code: number) => { statusCode = code; return res; }),
    json: jest.fn().mockImplementation((data: any) => { body = data; return res; }),
  };
  return { res, getStatus: () => statusCode, getBody: () => body };
}

describe('TalentumWebhookController (ack)', () => {
  let inbox: { insertReceived: jest.Mock };
  let publisher: { publish: jest.Mock };
  let controller: TalentumWebhookController;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    inbox = { insertReceived: jest.fn().mockResolvedValue({ id: 'inbox-1', duplicate: false }) };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    controller = new TalentumWebhookController(inbox as never, publisher as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errSpy = jest.spyOn(console, 'error').mockImplementation();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  async function post(body: any, partnerContext?: any, headers: Record<string, any> = {}) {
    const r = makeMockRes();
    await controller.handlePrescreening(makeMockReq(body, partnerContext, headers) as Request, r.res as Response);
    return r;
  }

  describe('validação mínima (400)', () => {
    it.each([
      ['body vazio', {}],
      ['body null', null],
      ['body undefined', undefined],
      ['sem action', { subtype: 'INITIATED' }],
      ['action não-string', { action: 3 }],
      ['prescreening.id ausente', makeResponsePayload({ prescreening: { id: undefined } })],
      ['prescreening.id vazio', makeResponsePayload({ prescreening: { id: '' } })],
      ['profile ausente', (() => { const p: any = makeResponsePayload(); delete p.data.profile; return p; })()],
      ['profile.id vazio', makeResponsePayload({ profile: { id: '' } })],
      ['PRESCREENING sem _id', { action: 'PRESCREENING', subtype: 'CREATED', data: { name: 'x' } }],
    ])('400 com %s, sem gravar nem publicar', async (_nome, body) => {
      const { getStatus } = await post(body);
      expect(getStatus()).toBe(400);
      expect(inbox.insertReceived).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('não exige mais o Zod completo no ack: e-mail inválido e campo extra passam (a validação é do processador)', async () => {
      const { getStatus } = await post(makeResponsePayload({ profile: { email: 'nao-e-email', extra: 1 } }));
      expect(getStatus()).toBe(200);
      expect(inbox.insertReceived).toHaveBeenCalledTimes(1);
    });
  });

  describe('ack', () => {
    it('PRESCREENING_RESPONSE → inbox + publish do id + 200 { received: true }; o caso de uso NÃO roda', async () => {
      const execSpy = jest.spyOn(ProcessTalentumPrescreening.prototype, 'execute');
      const { getStatus, getBody } = await post(makeResponsePayload({ subtype: 'ANALYZED' }), { isTest: false });

      expect(getStatus()).toBe(200);
      expect(getBody()).toEqual({ received: true });
      expect(inbox.insertReceived).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRESCREENING_RESPONSE', subtype: 'ANALYZED', prescreeningId: 'tp-001', profileId: 'prof-001' }));
      expect(publisher.publish).toHaveBeenCalledWith('inbox-1');
      expect(execSpy).not.toHaveBeenCalled();
      execSpy.mockRestore();
    });

    it('PRESCREENING.CREATED → inbox + 200; CreateJobPostingFromTalentumUseCase NÃO roda no ack', async () => {
      const execSpy = jest.spyOn(CreateJobPostingFromTalentumUseCase.prototype, 'execute');
      const { getStatus, getBody } = await post(makeCreatedPayload('proj-9'));

      expect(getStatus()).toBe(200);
      expect(getBody()).toEqual({ received: true });
      expect(inbox.insertReceived).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRESCREENING', subtype: 'CREATED', prescreeningId: 'proj-9', profileId: null }));
      expect(execSpy).not.toHaveBeenCalled();
      execSpy.mockRestore();
    });

    it('INSERT falha → 503 { error: "retry" } e nada é publicado', async () => {
      inbox.insertReceived.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
      const { getStatus, getBody } = await post(makeResponsePayload());
      expect(getStatus()).toBe(503);
      expect(getBody()).toEqual({ error: 'retry' });
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('publish falha → 200 mesmo assim', async () => {
      publisher.publish.mockRejectedValue(new Error('pubsub down'));
      const { getStatus, getBody } = await post(makeResponsePayload());
      expect(getStatus()).toBe(200);
      expect(getBody()).toEqual({ received: true });
    });

    it('duplicado → 200', async () => {
      inbox.insertReceived.mockResolvedValue({ id: 'inbox-0', duplicate: true });
      expect((await post(makeResponsePayload())).getStatus()).toBe(200);
    });

    it('nenhum log carrega o e-mail, o telefone ou o nome do payload', async () => {
      await post(makeResponsePayload());
      const lines = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].map((c) => c.join(' ')).join('\n');
      expect(lines).not.toContain('test@example.com');
      expect(lines).not.toContain('+5491100000000');
      expect(lines).not.toContain('Test User');
    });
  });

  describe('propagação de environment e ingress_host', () => {
    it.each([
      ['isTest=false', { isTest: false }, 'production'],
      ['isTest=true', { isTest: true }, 'test'],
      ['partnerContext ausente', undefined, 'production'],
      ['isTest undefined', {}, 'production'],
    ])('%s → environment=%s', async (_nome, partnerContext, esperado) => {
      await post(makeResponsePayload(), partnerContext);
      expect(inbox.insertReceived).toHaveBeenCalledWith(expect.objectContaining({ environment: esperado }));
    });

    it('ingress_host = X-Forwarded-Host quando presente; senão Host; senão null', async () => {
      await post(makeResponsePayload(), undefined, { 'x-forwarded-host': 'api.enlite.health', host: 'worker-functions.run.app' });
      expect(inbox.insertReceived).toHaveBeenLastCalledWith(expect.objectContaining({ ingressHost: 'api.enlite.health' }));

      await post(makeResponsePayload(), undefined, { host: 'worker-functions.run.app' });
      expect(inbox.insertReceived).toHaveBeenLastCalledWith(expect.objectContaining({ ingressHost: 'worker-functions.run.app' }));

      await post(makeResponsePayload());
      expect(inbox.insertReceived).toHaveBeenLastCalledWith(expect.objectContaining({ ingressHost: null }));
    });
  });
});
