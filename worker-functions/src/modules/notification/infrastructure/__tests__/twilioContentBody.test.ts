/**
 * twilioContentBody.test.ts — trava a REGRA, não o caso.
 *
 * O defeito que originou este arquivo: duas funções extraíam o corpo do Content
 * com semânticas diferentes e escreviam a mesma coluna; uma delas devolvia um
 * literal ("[Template não-textual …]") que a tela mostrou como se fosse a
 * mensagem da cuidadora. O teste que impede a volta não é "reconhece este
 * literal" — é **`extractContentBody` nunca devolve texto que não veio do
 * Content**, para qualquer sentinela que alguém invente depois.
 */
import { extractContentBody, contentBodyOrSentinel, NON_TEXTUAL_SENTINEL } from '../twilioContentBody';

describe('extractContentBody — texto real ou null', () => {
  it('devolve o body do tipo de maior preferência', () => {
    expect(extractContentBody({ 'twilio/text': { body: 'TEXT' }, 'twilio/card': { body: 'CARD' } })).toBe('TEXT');
    expect(extractContentBody({ 'twilio/card': { body: 'CARD' } })).toBe('CARD');
    expect(extractContentBody({ 'twilio/quick-reply': { body: 'QR' }, 'twilio/list-picker': { body: 'LP' } })).toBe('QR');
  });

  it('tipo fora da lista de preferência ainda vale, se tiver texto (a lista é ORDEM, não allowlist)', () => {
    expect(extractContentBody({ 'twilio/tipo-que-a-twilio-lançar-amanhã': { body: 'NOVO' } })).toBe('NOVO');
  });

  it('sem texto → null: título de card NÃO é a mensagem', () => {
    expect(extractContentBody({ 'twilio/card': { title: 'Só um título' } })).toBeNull();
    expect(extractContentBody({ 'twilio/text': { body: '   ' } })).toBeNull();
    expect(extractContentBody({})).toBeNull();
    expect(extractContentBody(null)).toBeNull();
    expect(extractContentBody(undefined)).toBeNull();
  });

  it('NUNCA inventa texto: o que sai ou veio do Content, ou é null', () => {
    const semTexto = [{}, { 'twilio/card': { title: 't', subtitle: 's' } }, { 'twilio/text': {} }];
    for (const types of semTexto) {
      const out = extractContentBody(types);
      expect(out).toBeNull();
      expect(out).not.toBe(NON_TEXTUAL_SENTINEL);
    }
  });
});

describe('contentBodyOrSentinel — a ÚNICA porta do sentinela (coluna legada `body`, NOT NULL)', () => {
  it('prefere texto, cai para título, e só então o sentinela', () => {
    expect(contentBodyOrSentinel({ 'twilio/text': { body: 'TEXT' } })).toBe('TEXT');
    expect(contentBodyOrSentinel({ 'twilio/card': { title: 'TITULO' } })).toBe('TITULO');
    expect(contentBodyOrSentinel({ 'twilio/card': {} })).toBe(NON_TEXTUAL_SENTINEL);
    expect(contentBodyOrSentinel(null)).toBe(NON_TEXTUAL_SENTINEL);
  });

  it('o sentinela sai daqui e SÓ daqui — a função de exibição devolve null no mesmo caso', () => {
    const types = { 'twilio/card': { title: 'TITULO' } };
    expect(contentBodyOrSentinel(types)).toBe('TITULO');
    expect(extractContentBody(types)).toBeNull();
  });
});
