/**
 * O único componente do sistema que ESCREVE na Twilio.
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. **Desligado, ele NÃO chama a rede.** Não é sobre devolver erro bonito: é
 *    que `fetch` tem de ficar em ZERO chamadas. Uma trava que erra depois de
 *    chamar não é trava. Medido com espião.
 * 2. **A flag é estrita.** 'TRUE', '1' e 'yes' NÃO ligam. Flag que aceita
 *    variação é flag que alguém liga sem querer.
 * 3. **200 sem `sid` falha alto.** Seria o pior caso silencioso: o Content
 *    existe na Twilio e nós ficamos sem a chave para achá-lo.
 * 4. Criar e submeter são chamadas SEPARADAS — criar é reversível, submeter não.
 */
import { TwilioContentWriter, TwilioSubmissionDisabledError } from '../TwilioContentWriter';

const LIGADO = ['ACfake', 'tokenfake', 'true'] as const;

function espiaoFetch(resposta: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  const espiao = jest.fn().mockResolvedValue({
    ok: resposta.ok,
    status: resposta.status ?? (resposta.ok ? 200 : 500),
    statusText: 'x',
    json: async () => resposta.json ?? {},
    text: async () => resposta.text ?? '',
  });
  global.fetch = espiao as unknown as typeof fetch;
  return espiao;
}

const conteudo = {
  friendlyName: 'ar_bienvenida',
  language: 'es-AR',
  body: 'Hola {{1}}, todo bien',
  variaveis: ['worker_name'],
};

afterEach(() => { jest.restoreAllMocks(); });

describe('🔒 as três travas — e nenhuma chama a rede', () => {
  it('sem a flag, `indisponivel` diz flag_desligada e fetch fica em ZERO', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXa' } });
    const w = new TwilioContentWriter('ACfake', 'tokenfake', undefined);
    expect(w.indisponivel).toBe('flag_desligada');
    expect(w.configured).toBe(false);
    await expect(w.criarContent(conteudo)).rejects.toBeInstanceOf(TwilioSubmissionDisabledError);
    expect(espiao).toHaveBeenCalledTimes(0);
  });

  it('com a flag mas sem credencial, diz sem_credencial e fetch fica em ZERO', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXa' } });
    const w = new TwilioContentWriter(undefined, undefined, 'true');
    expect(w.indisponivel).toBe('sem_credencial');
    await expect(w.submeterParaAprovacao('HXa', 'n', 'UTILITY')).rejects.toBeInstanceOf(TwilioSubmissionDisabledError);
    expect(espiao).toHaveBeenCalledTimes(0);
  });

  it('só o token, sem o account sid, também é sem_credencial', () => {
    expect(new TwilioContentWriter(undefined, 'tok', 'true').indisponivel).toBe('sem_credencial');
    expect(new TwilioContentWriter('AC', undefined, 'true').indisponivel).toBe('sem_credencial');
  });

  it('🔒 a flag é ESTRITA: TRUE, 1 e yes NÃO ligam', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
      expect(new TwilioContentWriter('AC', 'tok', v).indisponivel).toBe('flag_desligada');
    }
    expect(new TwilioContentWriter('AC', 'tok', 'true').indisponivel).toBeNull();
  });

  it('ligado e com credencial, configured é true', () => {
    expect(new TwilioContentWriter(...LIGADO).configured).toBe(true);
  });

  it('lê do process.env quando nada é passado', () => {
    const antes = { ...process.env };
    try {
      process.env.TWILIO_ACCOUNT_SID = 'ACenv';
      process.env.TWILIO_AUTH_TOKEN = 'tokenv';
      process.env.TEMPLATE_SUBMISSION_ENABLED = 'true';
      expect(new TwilioContentWriter().configured).toBe(true);
    } finally {
      process.env = antes;
    }
  });
});

describe('criarContent — reversível', () => {
  it('POSTa em /v1/Content e devolve o sid', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXnovo' } });
    const w = new TwilioContentWriter(...LIGADO);
    expect(await w.criarContent(conteudo)).toEqual({ sid: 'HXnovo' });

    const [url, init] = espiao.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://content.twilio.com/v1/Content');
    expect(init.method).toBe('POST');
    const corpo = JSON.parse(init.body as string);
    expect(corpo.friendly_name).toBe('ar_bienvenida');
    expect(corpo.types['twilio/text'].body).toBe('Hola {{1}}, todo bien');
  });

  it('as variáveis viram mapa numerado a partir de 1 — é o que faz o {{1}} valer', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXa' } });
    await new TwilioContentWriter(...LIGADO).criarContent({
      ...conteudo, variaveis: ['worker_name', 'case_number'],
    });
    const corpo = JSON.parse((espiao.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(corpo.variables).toEqual({ '1': 'worker_name', '2': 'case_number' });
  });

  it('sem variável nenhuma manda mapa vazio, não undefined', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXa' } });
    await new TwilioContentWriter(...LIGADO).criarContent({ ...conteudo, variaveis: [] });
    const corpo = JSON.parse((espiao.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(corpo.variables).toEqual({});
  });

  it('manda o Basic auth', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXa' } });
    await new TwilioContentWriter(...LIGADO).criarContent(conteudo);
    const init = (espiao.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from('ACfake:tokenfake').toString('base64')}`);
  });

  it('erro HTTP vira Error com o status e o corpo — não some', async () => {
    espiaoFetch({ ok: false, status: 400, text: 'friendly_name já existe' });
    await expect(new TwilioContentWriter(...LIGADO).criarContent(conteudo))
      .rejects.toThrow(/400 ao criar Content: friendly_name já existe/);
  });

  it('corpo de erro ilegível não estoura — vira mensagem sem detalhe', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'x',
      text: async () => { throw new Error('sem corpo'); },
    }) as unknown as typeof fetch;
    await expect(new TwilioContentWriter(...LIGADO).criarContent(conteudo))
      .rejects.toThrow(/500 ao criar Content/);
  });

  it('🔒 200 SEM sid falha alto — Content órfão é pior que erro', async () => {
    espiaoFetch({ ok: true, json: { nada: true } });
    await expect(new TwilioContentWriter(...LIGADO).criarContent(conteudo))
      .rejects.toThrow(/200 sem `sid`/);
  });
});

describe('submeterParaAprovacao — IRREVERSÍVEL', () => {
  it('POSTa no endpoint de aprovação do WhatsApp com nome e categoria', async () => {
    const espiao = espiaoFetch({ ok: true, json: {} });
    const r = await new TwilioContentWriter(...LIGADO).submeterParaAprovacao('HXabc', 'ar_bienvenida', 'UTILITY');
    expect(r).toEqual({ contentSid: 'HXabc', name: 'ar_bienvenida', category: 'UTILITY' });

    const [url, init] = espiao.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://content.twilio.com/v1/Content/HXabc/ApprovalRequests/whatsapp');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'ar_bienvenida', category: 'UTILITY' });
  });

  it('erro HTTP vira Error com status e corpo', async () => {
    espiaoFetch({ ok: false, status: 409, text: 'nome em uso na WABA' });
    await expect(new TwilioContentWriter(...LIGADO).submeterParaAprovacao('HXa', 'n', 'UTILITY'))
      .rejects.toThrow(/409 ao submeter à Meta: nome em uso na WABA/);
  });

  it('corpo de erro ilegível não estoura', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'x',
      text: async () => { throw new Error('sem corpo'); },
    }) as unknown as typeof fetch;
    await expect(new TwilioContentWriter(...LIGADO).submeterParaAprovacao('HXa', 'n', 'UTILITY'))
      .rejects.toThrow(/500 ao submeter à Meta/);
  });

  it('🔒 criar e submeter são chamadas SEPARADAS — uma não dispara a outra', async () => {
    const espiao = espiaoFetch({ ok: true, json: { sid: 'HXa' } });
    await new TwilioContentWriter(...LIGADO).criarContent(conteudo);
    expect(espiao).toHaveBeenCalledTimes(1);
    expect((espiao.mock.calls[0] as [string])[0]).not.toContain('ApprovalRequests');
  });
});
