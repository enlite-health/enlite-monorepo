/**
 * PeriskopeGroupNotifyService.test.ts
 *
 * Cenários:
 * 1. não configurado (sem PERISKOPE_API_KEY/PHONE) → false, sem chamada HTTP
 * 2. chat_id que não é grupo (@c.us) → REJEITADO (trava: nunca 1-1 por aqui)
 * 3. envio ok → POST /message/send com {chat_id, message}, retorna true
 * 4. erro HTTP → false, nunca lança (best-effort)
 */
import axios from 'axios';
import { PeriskopeGroupNotifyService } from '../PeriskopeGroupNotifyService';

jest.mock('axios');
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const GROUP = '120363334377379340@g.us';

describe('PeriskopeGroupNotifyService', () => {
  const OLD_ENV = process.env;
  let mockPost: jest.Mock;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PERISKOPE_API_KEY = 'test-key';
    process.env.PERISKOPE_PHONE = '5491176360496';
    mockPost = jest.fn().mockResolvedValue({ status: 200 });
    mockedAxios.create.mockReturnValue({ post: mockPost } as never);
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('não configurado → false, sem HTTP', async () => {
    delete process.env.PERISKOPE_API_KEY;
    const svc = new PeriskopeGroupNotifyService();
    expect(await svc.sendToGroup(GROUP, 'msg')).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('chat_id 1-1 (@c.us) é rejeitado — só grupo', async () => {
    const svc = new PeriskopeGroupNotifyService();
    expect(await svc.sendToGroup('5491122364870@c.us', 'msg')).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('envio ok → POST /message/send, true', async () => {
    const svc = new PeriskopeGroupNotifyService();
    expect(await svc.sendToGroup(GROUP, 'hola equipo')).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/message/send', {
      chat_id: GROUP,
      message: 'hola equipo',
    });
  });

  it('erro HTTP → false, nunca lança', async () => {
    mockPost.mockRejectedValue(new Error('401 Unauthorized'));
    const svc = new PeriskopeGroupNotifyService();
    expect(await svc.sendToGroup(GROUP, 'msg')).toBe(false);
  });
});
