import {
  assertGuestsAllowed,
  EnquadreConfigError,
  EnquadreGuestNotAllowedError,
  parseGuestPolicy,
  resolveEnquadreCalendarId,
} from '../enquadreCalendarConfig';

describe('config do enquadre — agenda e política de convidados (spec 052)', () => {
  describe('resolveEnquadreCalendarId', () => {
    it('lê ENQUADRE_CALENDAR_ID_<PAÍS>', () => {
      expect(resolveEnquadreCalendarId('AR', { ENQUADRE_CALENDAR_ID_AR: ' cal-ar ' })).toBe('cal-ar');
      expect(resolveEnquadreCalendarId('BR', { ENQUADRE_CALENDAR_ID_BR: 'cal-br' })).toBe('cal-br');
    });
    it('ausente ou vazia → erro nomeado com o nome da variável', () => {
      expect(() => resolveEnquadreCalendarId('AR', {})).toThrow(EnquadreConfigError);
      expect(() => resolveEnquadreCalendarId('BR', { ENQUADRE_CALENDAR_ID_BR: '  ', ENQUADRE_CALENDAR_ID_AR: 'x' })).toThrow(/ENQUADRE_CALENDAR_ID_BR/);
    });
  });

  describe('parseGuestPolicy (fail-closed)', () => {
    it('AUSENTE → lança', () => {
      expect(() => parseGuestPolicy({})).toThrow(EnquadreConfigError);
      expect(() => parseGuestPolicy({ ENQUADRE_GUEST_POLICY: '   ' })).toThrow(/ENQUADRE_GUEST_POLICY/);
    });
    it('malformada → lança', () => {
      for (const bad of ['todos', 'ALL', 'allowlist', 'allowlist:', 'allowlist:a@b.com', 'allowlist:semponto', 'allowlist:ok.com,', 'allowlist:ok.com,,x.com']) {
        expect(() => parseGuestPolicy({ ENQUADRE_GUEST_POLICY: bad })).toThrow(EnquadreConfigError);
      }
    });
    it('`all` e `allowlist:` válidos', () => {
      expect(parseGuestPolicy({ ENQUADRE_GUEST_POLICY: 'all' })).toEqual({ kind: 'all' });
      expect(parseGuestPolicy({ ENQUADRE_GUEST_POLICY: 'allowlist: Example.test , qa.enlite.health' })).toEqual({
        kind: 'allowlist',
        domains: ['example.test', 'qa.enlite.health'],
      });
    });
  });

  describe('assertGuestsAllowed', () => {
    it('`all` aceita qualquer e-mail', () => {
      expect(() => assertGuestsAllowed({ kind: 'all' }, ['a@qualquer.com', 'sem-arroba'])).not.toThrow();
    });
    it('allowlist aceita domínio da lista (sem diferenciar maiúsculas)', () => {
      const policy = parseGuestPolicy({ ENQUADRE_GUEST_POLICY: 'allowlist:example.test' });
      expect(() => assertGuestsAllowed(policy, ['a@example.test', 'B@EXAMPLE.TEST'])).not.toThrow();
    });
    it('allowlist recusa domínio fora e subdomínio; mensagem só com a QUANTIDADE, nunca o e-mail', () => {
      const policy = parseGuestPolicy({ ENQUADRE_GUEST_POLICY: 'allowlist:example.test' });
      let caught: unknown;
      try {
        assertGuestsAllowed(policy, ['ok@example.test', 'fora1@outro.com', 'fora2@sub.example.test', 'sem-arroba']);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EnquadreGuestNotAllowedError);
      const err = caught as EnquadreGuestNotAllowedError;
      expect(err.code).toBe('ENQUADRE_GUEST_NOT_ALLOWED');
      expect(err.refusedCount).toBe(3);
      expect(err.message).toContain('3');
      expect(err.message).not.toMatch(/@|outro\.com|fora1|fora2/);
    });
  });
});
