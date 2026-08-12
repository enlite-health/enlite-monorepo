import { Request, Response } from 'express';
import { ChatwootMirrorController } from '../ChatwootMirrorController';

function mockRes() {
  return { status: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() } as unknown as Response;
}
function mockReq(body: any, headers: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { body, headers, query } as unknown as Request;
}

describe('ChatwootMirrorController → nota no Periskope', () => {
  let note: { mirrorAsNote: jest.Mock };
  let controller: ChatwootMirrorController;

  beforeEach(() => {
    note = { mirrorAsNote: jest.fn().mockResolvedValue(true) };
    controller = new ChatwootMirrorController(note as any);
    process.env.PERISKOPE_NOTE_MIRROR_ENABLED = 'true';
    delete process.env.CHATWOOT_MIRROR_WEBHOOK_TOKEN;
  });
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.PERISKOPE_NOTE_MIRROR_ENABLED;
  });

  const incoming = {
    event: 'message_created',
    message_type: 'incoming',
    content: 'hola, tengo una duda',
    conversation: { meta: { sender: { phone_number: '+5491112345678' } } },
  };

  it('mensagem do worker (incoming) → nota sem prefixo', async () => {
    await controller.handle(mockReq(incoming), mockRes());
    expect(note.mirrorAsNote).toHaveBeenCalledWith('+5491112345678', 'hola, tengo una duda');
  });

  it('resposta da Luz (outgoing) → nota com 🤖 Luz:', async () => {
    await controller.handle(mockReq({ ...incoming, message_type: 'outgoing', content: 'claro, te ayudo' }), mockRes());
    expect(note.mirrorAsNote).toHaveBeenCalledWith('+5491112345678', '🤖 Luz: claro, te ayudo');
  });

  it('nota privada / activity → não espelha', async () => {
    await controller.handle(mockReq({ ...incoming, private: true }), mockRes());
    await controller.handle(mockReq({ ...incoming, message_type: 'activity' }), mockRes());
    expect(note.mirrorAsNote).not.toHaveBeenCalled();
  });

  it('flag OFF → não espelha (deploy neutro)', async () => {
    delete process.env.PERISKOPE_NOTE_MIRROR_ENABLED;
    await controller.handle(mockReq(incoming), mockRes());
    expect(note.mirrorAsNote).not.toHaveBeenCalled();
  });

  it('token errado → 403, não espelha', async () => {
    process.env.CHATWOOT_MIRROR_WEBHOOK_TOKEN = 'secret';
    const res = mockRes();
    await controller.handle(mockReq(incoming, { 'x-mirror-token': 'wrong' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(note.mirrorAsNote).not.toHaveBeenCalled();
  });

  it('evento não-message_created → ignora com 200', async () => {
    const res = mockRes();
    await controller.handle(mockReq({ event: 'conversation_updated' }), res);
    expect(note.mirrorAsNote).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
