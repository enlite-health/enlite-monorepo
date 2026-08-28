import { isAntiLockoutError, LAST_MANAGER_ERROR } from '../lastManager';

describe('isAntiLockoutError', () => {
  it('reconhece o RAISE 23514 com `anti-lockout` no texto', () => {
    expect(isAntiLockoutError({ code: '23514', message: 'x (anti-lockout)' })).toBe(true);
  });
  it.each([
    ['23514 sem a palavra', { code: '23514', message: 'CHECK de feature_key' }],
    ['outro SQLSTATE com a palavra', { code: '23503', message: 'anti-lockout' }],
    ['sem mensagem', { code: '23514' }],
    ['null', null],
    ['string', 'anti-lockout'],
  ])('%s não é', (_n, err) => {
    expect(isAntiLockoutError(err)).toBe(false);
  });
  it('o código da API é o do painel', () => {
    expect(LAST_MANAGER_ERROR).toBe('last_manager');
  });
});
