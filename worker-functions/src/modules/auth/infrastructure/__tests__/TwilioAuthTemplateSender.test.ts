/**
 * T-F3c-109 — TwilioAuthTemplateSender (D758, T-c). DUBLÊ do cliente Twilio: nenhum teste faz chamada de rede
 * (a guarda R-16 do jest, `scripts/rede-bloqueada-em-teste.cjs`, derruba qualquer conexão externa). Sem credencial real.
 */
import { TwilioAuthTemplateSender } from '../TwilioAuthTemplateSender';

const CONTENT_SID = 'HX00000000000000000000000000000000';
const LUZ = '+5491100000000';
const TO = '+5491122223333';
const CODE = '123456';

function makeClient() {
  const create = jest.fn();
  return { client: { messages: { create } }, create };
}

describe('TwilioAuthTemplateSender', () => {
  it('T-F3c-109 payload: contentSid do template e contentVariables com o código', async () => {
    const { client, create } = makeClient();
    create.mockResolvedValue({ sid: 'SM_FAKE_1' });

    const out = await new TwilioAuthTemplateSender(client, { contentSid: CONTENT_SID, fromNumber: LUZ }).send({ toE164: TO, code: CODE });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      to: `whatsapp:${TO}`,
      contentSid: CONTENT_SID,
      contentVariables: JSON.stringify({ '1': CODE }),
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('body');
    expect(out).toEqual({ twilioSid: 'SM_FAKE_1', suppressed: false });
  });

  it('T-F3c-109 remetente: sai pelo número da Luz (ou pelo Messaging Service, nunca os dois)', async () => {
    const { client, create } = makeClient();
    create.mockResolvedValue({ sid: 'SM_FAKE_2' });

    await new TwilioAuthTemplateSender(client, { contentSid: CONTENT_SID, fromNumber: LUZ }).send({ toE164: TO, code: CODE });
    expect(create.mock.calls[0][0].from).toBe(`whatsapp:${LUZ}`);
    expect(create.mock.calls[0][0]).not.toHaveProperty('messagingServiceSid');

    await new TwilioAuthTemplateSender(client, { contentSid: CONTENT_SID, fromNumber: LUZ, messagingServiceSid: 'MG00000000000000000000000000000000' }).send({ toE164: TO, code: CODE });
    expect(create.mock.calls[1][0].messagingServiceSid).toBe('MG00000000000000000000000000000000');
    expect(create.mock.calls[1][0]).not.toHaveProperty('from');
  });

  it('T-F3c-109 erro: falha do Twilio vira OTP_CHANNEL_UNAVAILABLE, uma tentativa, sem SMS', async () => {
    const { client, create } = makeClient();
    create.mockRejectedValue(Object.assign(new Error('boom'), { code: 63016 }));

    await expect(
      new TwilioAuthTemplateSender(client, { contentSid: CONTENT_SID, fromNumber: LUZ }).send({ toE164: TO, code: CODE }),
    ).rejects.toThrow('OTP_CHANNEL_UNAVAILABLE');

    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0][0])).not.toMatch(/sms/i);
  });

  it('T-F3c-109 FR-95: ficha is_test + token @enlite.test, o cliente NÃO é chamado; ficha real com token de teste, é', async () => {
    const { client, create } = makeClient();
    create.mockResolvedValue({ sid: 'SM_FAKE_3' });
    const sender = new TwilioAuthTemplateSender(client, { contentSid: CONTENT_SID, fromNumber: LUZ });

    const suprimido = await sender.send({ toE164: TO, code: CODE, ctx: { workerId: 'w1', fichaIsTest: true, tokenEmail: 'qa.x@enlite.test' } });
    expect(suprimido).toEqual({ suppressed: true });
    expect(create).not.toHaveBeenCalled();

    await sender.send({ toE164: TO, code: CODE, ctx: { workerId: 'w2', fichaIsTest: false, tokenEmail: 'qa.x@enlite.test' } });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
