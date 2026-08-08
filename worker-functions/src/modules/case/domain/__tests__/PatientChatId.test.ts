import { CHAT_ID_MAX_LENGTH, GROUP_CHAT_ID_PATTERN, isGroupChatId } from '../PatientChatId';

describe('PatientChatId', () => {
  describe('isGroupChatId — aceita só GRUPO', () => {
    it.each([
      ['formato novo (18 dígitos)', '120363001234567890@g.us'],
      ['formato legado (criador-timestamp)', '5491112345678-1600000000@g.us'],
      ['um dígito de cada lado', '1-2@g.us'],
    ])('aceita %s', (_label, value) => {
      expect(isGroupChatId(value)).toBe(true);
    });

    it.each([
      ['conversa 1-1 (@c.us) — o bug que a trava existe para impedir', '5491162180721@c.us'],
      ['sem sufixo', '120363001234567890'],
      ['sufixo de broadcast', '120363001234567890@broadcast'],
      ['letras no id', 'abc123@g.us'],
      ['espaço no meio', '12036300 1234567890@g.us'],
      ['string vazia', ''],
      ['só o sufixo', '@g.us'],
      ['dois hífens', '1-2-3@g.us'],
      ['ponto não escapado (g_us)', '120363001234567890@gxus'],
      ['sufixo em maiúscula', '120363001234567890@G.US'],
      ['prefixo antes do número', 'x120363001234567890@g.us'],
      ['lixo depois do sufixo', '120363001234567890@g.us '],
    ])('recusa %s', (_label, value) => {
      expect(isGroupChatId(value)).toBe(false);
    });

    it('recusa acima do tamanho da coluna, mesmo com formato válido', () => {
      const tooLong = `${'1'.repeat(CHAT_ID_MAX_LENGTH)}@g.us`;
      expect(tooLong.length).toBeGreaterThan(CHAT_ID_MAX_LENGTH);
      expect(GROUP_CHAT_ID_PATTERN.test(tooLong)).toBe(true); // o padrão sozinho passaria
      expect(isGroupChatId(tooLong)).toBe(false); // o guard de tamanho barra
    });

    it('aceita exatamente no limite da coluna', () => {
      const atLimit = `${'1'.repeat(CHAT_ID_MAX_LENGTH - '@g.us'.length)}@g.us`;
      expect(atLimit).toHaveLength(CHAT_ID_MAX_LENGTH);
      expect(isGroupChatId(atLimit)).toBe(true);
    });

    it('o padrão não é global (sem lastIndex sujo entre chamadas)', () => {
      const value = '120363001234567890@g.us';
      expect(GROUP_CHAT_ID_PATTERN.test(value)).toBe(true);
      expect(GROUP_CHAT_ID_PATTERN.test(value)).toBe(true);
    });
  });
});
