/**
 * T-F3c-DB-12 — push FCM de apagamento (spec 077, D795). Dublê do `messaging()`: NENHUM envio a aparelho real,
 * nenhuma chamada de rede (guarda R-16 do repo).
 */
import { FcmPushSender, type MessagingLike } from '../../infrastructure/FcmPushSender';
import { WIPE_ORDER } from '../../domain/WorkerDevice';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));
const mockLogger = jest.requireMock('@shared/logging').logger as { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

const TOKEN = 'fcm-token-SECRETO-1234567890';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

describe('T-F3c-DB-12 FcmPushSender', () => {
  beforeEach(() => jest.clearAllMocks());

  it('T-F3c-DB-12 o payload `data` tem SÓ a ordem e o id opaco (nada de nome, telefone ou texto) e não há `notification`', async () => {
    const send = jest.fn().mockResolvedValue('projects/x/messages/1');
    const ok = await new FcmPushSender(() => ({ send }) as MessagingLike).send({ token: TOKEN, order: WIPE_ORDER, deviceId: DEVICE_ID });
    expect(ok).toBe(true);
    const sent = send.mock.calls[0][0];
    expect(sent.token).toBe(TOKEN);
    expect(Object.keys(sent.data).sort()).toEqual(['deviceId', 'order']);
    expect(sent.data).toEqual({ order: 'wipe', deviceId: DEVICE_ID });
    expect(sent).not.toHaveProperty('notification');
    expect(Object.keys(sent).sort()).toEqual(['android', 'data', 'token']);
  });

  it('T-F3c-DB-12 a prioridade é alta (android.priority = high)', async () => {
    const send = jest.fn().mockResolvedValue('id');
    await new FcmPushSender(() => ({ send }) as MessagingLike).send({ token: TOKEN, order: WIPE_ORDER, deviceId: DEVICE_ID });
    expect(send.mock.calls[0][0].android).toEqual({ priority: 'high' });
  });

  it('T-F3c-DB-12 em falha devolve false e NENHUM log contém o token', async () => {
    const boom = Object.assign(new Error(`registration token ${TOKEN} is not valid`), { code: 'messaging/registration-token-not-registered' });
    const ok = await new FcmPushSender(() => ({ send: jest.fn().mockRejectedValue(boom) }) as MessagingLike).send({ token: TOKEN, order: WIPE_ORDER, deviceId: DEVICE_ID });
    expect(ok).toBe(false);
    const logs = JSON.stringify([...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1); // controle positivo: o log existe e foi inspecionado
    expect(logs).not.toContain(TOKEN);
  });
});
