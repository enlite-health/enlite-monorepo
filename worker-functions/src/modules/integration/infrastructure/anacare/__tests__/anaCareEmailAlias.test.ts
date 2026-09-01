import { buildEmailAlias, MAX_EMAIL_ALIAS_ATTEMPTS } from '../anaCareEmailAlias';

describe('buildEmailAlias', () => {
  it('insere +N antes do @ preservando o domínio', () => {
    expect(buildEmailAlias('fulano@gmail.com', 1)).toBe('fulano+1@gmail.com');
    expect(buildEmailAlias('fulano@gmail.com', 3)).toBe('fulano+3@gmail.com');
  });

  it('preserva um +tag que já exista (o objetivo é endereço novo, não canônico)', () => {
    expect(buildEmailAlias('fulano+casa@gmail.com', 1)).toBe('fulano+casa+1@gmail.com');
  });

  it('separa pelo ÚLTIMO @', () => {
    expect(buildEmailAlias('"a@b"@dominio.com', 2)).toBe('"a@b"+2@dominio.com');
  });

  it('funciona com domínios que não são de webmail', () => {
    expect(buildEmailAlias('paola.folco@bue.edu.ar', 1)).toBe('paola.folco+1@bue.edu.ar');
  });

  it('recusa e-mail sem parte local, sem domínio ou sem @', () => {
    expect(() => buildEmailAlias('@gmail.com', 1)).toThrow(/parte local/);
    expect(() => buildEmailAlias('fulano@', 1)).toThrow(/domínio/);
    expect(() => buildEmailAlias('fulano', 1)).toThrow(/parte local/);
  });

  it('recusa tentativa inválida', () => {
    expect(() => buildEmailAlias('a@b.com', 0)).toThrow(/inteiro >= 1/);
    expect(() => buildEmailAlias('a@b.com', -1)).toThrow(/inteiro >= 1/);
    expect(() => buildEmailAlias('a@b.com', 1.5)).toThrow(/inteiro >= 1/);
  });

  it('o teto de tentativas é um inteiro positivo pequeno', () => {
    expect(Number.isInteger(MAX_EMAIL_ALIAS_ATTEMPTS)).toBe(true);
    expect(MAX_EMAIL_ALIAS_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MAX_EMAIL_ALIAS_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
