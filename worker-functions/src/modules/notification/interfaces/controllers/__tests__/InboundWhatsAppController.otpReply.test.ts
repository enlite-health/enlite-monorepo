/**
 * T-F3c-112 — a resposta da cuidadora à mensagem de código (template de autenticação, D758) não vira conversa da Luz, e o
 * envio do código não passa pelo espelho do Chatwoot. Dublês em memória: nenhum canal real (Twilio/Chatwoot/Periskope).
 */
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { InboundWhatsAppController } from '../InboundWhatsAppController';
import { TwilioAuthTemplateSender } from '../../../../auth/infrastructure/TwilioAuthTemplateSender';
import { ChatwootClient } from '../../../infrastructure/ChatwootClient';

const OTP_SID = 'SM_OTP_1';
const FROM = 'whatsapp:+5491100000021';

const res = () => ({ status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response;
const req = (body: Record<string, string>) => ({ body: { From: FROM, MessageSid: 'SM_IN_1', ...body }, headers: {} }) as unknown as Request;

function montar() {
  // `otp_challenges.twilio_sid = SM_OTP_1` existe; qualquer outro SID, não.
  const db = { query: jest.fn(async (_sql: string, params: unknown[]) => ({ rowCount: params[0] === OTP_SID ? 1 : 0, rows: [] })) };
  const triggerHandover = { execute: jest.fn().mockResolvedValue({ isFailure: false }) };
  const chatwoot = { mirrorIncomingMessage: jest.fn().mockResolvedValue(undefined) };
  const controller = new InboundWhatsAppController(db as never, triggerHandover as never, chatwoot as never);
  return { controller, db, chatwoot, triggerHandover };
}

describe('T-F3c-112 — resposta ao código OTP não é conversa da Luz', () => {
  beforeEach(() => {
    delete process.env.TWILIO_INBOUND_WEBHOOK_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.CHATWOOT_INBOUND_MIRROR_ENABLED = 'true';
    process.env.PERISKOPE_HANDOVER_ENABLED = 'true';
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.CHATWOOT_INBOUND_MIRROR_ENABLED;
    delete process.env.PERISKOPE_HANDOVER_ENABLED;
  });

  it('T-F3c-112 resposta a mensagem de código → a Luz NÃO é acionada (nem espelho, nem handover) e responde 200', async () => {
    const { controller, chatwoot, triggerHandover } = montar();
    const r = res();

    await controller.handleInbound(req({ Body: 'gracias', OriginalRepliedMessageSid: OTP_SID }), r);

    expect(chatwoot.mirrorIncomingMessage).not.toHaveBeenCalled();
    expect(triggerHandover.execute).not.toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalledWith(403);
    expect(r.send).toHaveBeenCalled();
  });

  it('T-F3c-112 mensagem comum (sem resposta a código) → a Luz é acionada como hoje', async () => {
    const { controller, chatwoot } = montar();

    await controller.handleInbound(req({ Body: 'hola, quiero postularme' }), res());
    await controller.handleInbound(req({ Body: 'gracias', OriginalRepliedMessageSid: 'SM_OUTRA_COISA', MessageSid: 'SM_IN_2' }), res());

    expect(chatwoot.mirrorIncomingMessage).toHaveBeenCalledTimes(2);
    expect(chatwoot.mirrorIncomingMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'hola, quiero postularme', externalId: 'SM_IN_1' }));
  });

  it('T-F3c-112 o envio do código não passa pelo espelho do Chatwoot', async () => {
    const mirrorOut = jest.spyOn(ChatwootClient.prototype, 'mirrorOutgoingMessage').mockResolvedValue(undefined);
    const create = jest.fn().mockResolvedValue({ sid: OTP_SID });
    await new TwilioAuthTemplateSender({ messages: { create } }, { contentSid: 'HX1', fromNumber: '+5491100000000' }).send({ toE164: '+5491100000021', code: '123456' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(mirrorOut).not.toHaveBeenCalled();
    // Estrutural: o caminho do código não importa o espelho nem o serviço de mensageria que o aciona.
    const dir = path.join(__dirname, '..', '..', '..', '..', 'auth', 'infrastructure');
    for (const f of ['TwilioAuthTemplateSender.ts', 'PgOtpChallengeService.ts']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/chatwoot|TwilioMessagingService/i);
    }
  });

  it('T-F3c-112 mensagem NOVA "Quiero unir mis datos" NÃO é engolida (chega ao atalho do triage-service), nem citando o código', async () => {
    const { controller, chatwoot } = montar();

    await controller.handleInbound(req({ Body: 'Quiero unir mis datos' }), res());
    await controller.handleInbound(req({ Body: 'Quiero unir mis datos', OriginalRepliedMessageSid: OTP_SID, MessageSid: 'SM_IN_2' }), res());

    expect(chatwoot.mirrorIncomingMessage).toHaveBeenCalledTimes(2);
    expect(chatwoot.mirrorIncomingMessage.mock.calls.map((c) => c[0].externalId)).toEqual(['SM_IN_1', 'SM_IN_2']);
  });
});
