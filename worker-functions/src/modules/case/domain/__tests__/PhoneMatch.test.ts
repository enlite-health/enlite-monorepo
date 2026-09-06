import { phoneMatchesResponsible } from '../PhoneMatch';

describe('phoneMatchesResponsible (spec 014 US-D3, lex D3.1)', () => {
  it('mesmos últimos 8 dígitos, prefixos diferentes → true', () => {
    expect(phoneMatchesResponsible('+5491151265663', ['5491151265663'])).toBe(true);
  });

  it('números totalmente diferentes → false', () => {
    expect(phoneMatchesResponsible('+5491151265663', ['+5491199998888'])).toBe(false);
  });

  it('patientPhone null → false', () => {
    expect(phoneMatchesResponsible(null, ['+5491151265663'])).toBe(false);
  });

  it('patientPhone undefined → false', () => {
    expect(phoneMatchesResponsible(undefined, ['+5491151265663'])).toBe(false);
  });

  it('lista de responsáveis vazia → false', () => {
    expect(phoneMatchesResponsible('+5491151265663', [])).toBe(false);
  });

  it('telefone de responsável null no meio da lista → ignorado, sem lançar', () => {
    expect(phoneMatchesResponsible('+5491151265663', [null, '5491151265663'])).toBe(true);
  });

  it('telefone curto demais (< 8 dígitos) → nunca compara (falso positivo evitado)', () => {
    expect(phoneMatchesResponsible('1234567', ['1234567'])).toBe(false);
  });

  it('bate com o SEGUNDO responsável, não só o primeiro', () => {
    expect(phoneMatchesResponsible('+5491151265663', ['+5491100000000', '5491151265663'])).toBe(true);
  });

  it('não normaliza country code igual — só compara os ÚLTIMOS 8 dígitos literais', () => {
    // 9 dígitos nacionais vs 9 dígitos nacionais, últimos 8 iguais
    expect(phoneMatchesResponsible('91151265663', ['1151265663'])).toBe(true);
  });
});
