/**
 * Item 55 (spec 078, M3b-2): teste NUNCA toca o canal real. Spy no módulo `twilio` (molde `TwilioMessagingService.test.ts`):
 * no caminho de teste o cliente real não é instanciado nem chamado e o dublê recebe N. O controle POSITIVO prova que o spy
 * enxerga o canal quando o adapter real é usado (senão "0 chamadas" poderia ser instrumento morto).
 */
import { TwilioMessagingService } from '../../../notification/infrastructure/TwilioMessagingService';
import { AvisoPedidoService, type AvisoConfig, type AvisosRegistroPort, type LinhaAviso } from '../../application/AvisoPedidoService';
import { criarWhatsappAviso, StubAvisoWhatsapp, TwilioAvisoWhatsapp } from '../avisoWhatsapp';

const mockCreate = jest.fn();
const mockTwilioFactory = jest.fn();
jest.mock('twilio', () => jest.fn((...a: unknown[]) => { mockTwilioFactory(...a); return { messages: { create: mockCreate } }; }));

const PEDIDO = '123e4567-e89b-12d3-a456-426614174000';
const CFG: AvisoConfig = {
  from: '+5491199990000', contentSid: 'HXsol', linkBase: 'https://app.enlite.test', reenvioHoras: 4,
  destinatarios: [{ uid: 'a', numero: '+5491100000001' }, { uid: 'b', numero: '+5491100000002' }, { uid: 'c', numero: '+5491100000003' }],
};
const registroNulo: AvisosRegistroPort = {
  registrar: async (_c, _l: LinhaAviso) => undefined, gravesSemDecisao: async () => [], tentativasTwilio: async () => [],
};
const servico = (whatsapp: ConstructorParameters<typeof AvisoPedidoService>[0]['whatsapp']) =>
  new AvisoPedidoService({ decisores: async () => [], inapp: { publishPedidoIa: async () => null }, whatsapp, registro: registroNulo, tx: (f) => f({} as never), config: () => CFG });

beforeEach(() => { mockCreate.mockReset(); mockTwilioFactory.mockReset(); });

describe('item 55 — o cliente twilio real nunca é instanciado nem chamado em teste', () => {
  it('NODE_ENV=test: a fábrica entrega o dublê; N destinatários = N chamadas ao dublê, 0 ao módulo twilio; `real` LANÇA', async () => {
    const real = jest.fn();
    const w = criarWhatsappAviso({ NODE_ENV: 'test' }, real);
    expect(w).toBeInstanceOf(StubAvisoWhatsapp);
    await servico(w).whatsappGrave(PEDIDO);
    expect((w as StubAvisoWhatsapp).calls).toHaveLength(3);
    expect(real).not.toHaveBeenCalled();
    expect(mockTwilioFactory).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(() => criarWhatsappAviso({ NODE_ENV: 'test', ADMISSION_EXTERNALS: 'real' }, real)).toThrow(/proibido com NODE_ENV=test/);
  });

  it('ADMISSION_EXTERNALS=fake (fora de test) também é dublê; fake em production sem marcador de stage LANÇA', () => {
    expect(criarWhatsappAviso({ ADMISSION_EXTERNALS: 'fake' }, jest.fn())).toBeInstanceOf(StubAvisoWhatsapp);
    expect(() => criarWhatsappAviso({ NODE_ENV: 'production', ADMISSION_EXTERNALS: 'fake' }, jest.fn())).toThrow(/proibido em produção/);
    expect(criarWhatsappAviso({ NODE_ENV: 'production', ADMISSION_EXTERNALS: 'fake', ENLITE_DEPLOY_ENV: 'stage' }, jest.fn())).toBeInstanceOf(StubAvisoWhatsapp);
    expect(mockTwilioFactory).not.toHaveBeenCalled();
  });

  it('CONTROLE POSITIVO: com o adapter real (twilio mockado) o spy ENXERGA a chamada — do número do Sol, com contentSid e só {"1": link}', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
    try {
      mockCreate.mockResolvedValue({ sid: 'SM1', status: 'queued' });
      const tw = new TwilioMessagingService({ findBySlug: jest.fn() } as never);
      const w = criarWhatsappAviso({ NODE_ENV: 'development' }, () => tw);
      expect(w).toBeInstanceOf(TwilioAvisoWhatsapp);
      await servico(w).whatsappGrave(PEDIDO);
      expect(mockCreate).toHaveBeenCalledTimes(3);
      const arg = mockCreate.mock.calls[0][0];
      expect(arg.from).toBe('whatsapp:+5491199990000'); // o número do Sol, não o TWILIO_WHATSAPP_NUMBER da Luz
      expect(arg.contentSid).toBe('HXsol');
      expect(JSON.parse(arg.contentVariables)).toEqual({ '1': `https://app.enlite.test/admin/pedidos-ia/${PEDIDO}` });
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_WHATSAPP_NUMBER;
    }
  });

  it('sem Twilio no boot: o adapter é indisponível, a tentativa vira falha e nada lança', async () => {
    const w = criarWhatsappAviso({ NODE_ENV: 'production' }, () => undefined);
    await expect(servico(w).whatsappGrave(PEDIDO)).resolves.toBeUndefined();
  });
});
