import { normalizePrescreeningResponseType } from '../normalizePrescreeningResponseType';

describe('normalizePrescreeningResponseType', () => {
  describe('modo padrão (fronteiras) — respeita a escolha explícita', () => {
    it('respeita ["text"] deliberado (recrutadora escolheu só-texto)', () => {
      expect(normalizePrescreeningResponseType(['text'])).toEqual(['text']);
    });

    it('respeita ["audio"]', () => {
      expect(normalizePrescreeningResponseType(['audio'])).toEqual(['audio']);
    });

    it('preserva ["text","audio"] em ordem canônica', () => {
      expect(normalizePrescreeningResponseType(['text', 'audio'])).toEqual(['text', 'audio']);
    });

    it('normaliza ordem invertida ["audio","text"] → ["text","audio"]', () => {
      expect(normalizePrescreeningResponseType(['audio', 'text'])).toEqual(['text', 'audio']);
    });

    it.each([null, undefined, [], 'text', 42, {}])(
      'aplica o default ["text","audio"] para entrada ausente/inválida %p',
      (input) => {
        expect(normalizePrescreeningResponseType(input as unknown)).toEqual(['text', 'audio']);
      },
    );

    it('descarta valores fora do domínio', () => {
      expect(normalizePrescreeningResponseType(['text', 'video', 'foo'])).toEqual(['text']);
    });

    it('entrada só com lixo cai no default', () => {
      expect(normalizePrescreeningResponseType(['video', 'foo'])).toEqual(['text', 'audio']);
    });
  });

  describe('modo forceAudio (fonte IA) — garante áudio', () => {
    it('força áudio quando a IA gera só ["text"]', () => {
      expect(normalizePrescreeningResponseType(['text'], { forceAudio: true })).toEqual([
        'text',
        'audio',
      ]);
    });

    it('mantém texto quando vem só ["audio"]', () => {
      expect(normalizePrescreeningResponseType(['audio'], { forceAudio: true })).toEqual([
        'text',
        'audio',
      ]);
    });

    it.each([null, undefined, [], 'nope'])(
      'força ["text","audio"] mesmo para entrada inválida %p',
      (input) => {
        expect(normalizePrescreeningResponseType(input as unknown, { forceAudio: true })).toEqual([
          'text',
          'audio',
        ]);
      },
    );
  });

  it('não muta o array de entrada', () => {
    const input = ['text'];
    normalizePrescreeningResponseType(input, { forceAudio: true });
    expect(input).toEqual(['text']);
  });
});
