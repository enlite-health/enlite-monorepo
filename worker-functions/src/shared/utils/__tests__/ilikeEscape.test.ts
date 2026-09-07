/**
 * ilikeEscape.test.ts
 *
 * A régua é o ALCANCE, não a sintaxe: o que estes testes travam é que um termo
 * digitado não possa mais escolher quantas linhas a consulta devolve.
 */
import { escapeIlikeWildcards, hasSearchableContent } from '../ilikeEscape';

describe('escapeIlikeWildcards', () => {
  it('🔒 neutraliza `%` — o curinga que casava a tabela inteira', () => {
    expect(escapeIlikeWildcards('%%')).toBe('\\%\\%');
    expect(escapeIlikeWildcards('%')).toBe('\\%');
  });

  it('🔒 neutraliza `_` — casa um caractere, e `__` varre igual', () => {
    expect(escapeIlikeWildcards('__')).toBe('\\_\\_');
  });

  it('🔒 escapa a própria barra: sem isto um termo terminado em `\\` deixaria a cláusula ESCAPE pendurada', () => {
    expect(escapeIlikeWildcards('Ana\\')).toBe('Ana\\\\');
    expect(escapeIlikeWildcards('\\%')).toBe('\\\\\\%');
  });

  it('preserva curinga no MEIO de um nome real, sem comer o resto', () => {
    expect(escapeIlikeWildcards('Ana%Paz')).toBe('Ana\\%Paz');
  });

  it('não mexe em nome comum — inclusive com acento, espaço e vírgula', () => {
    expect(escapeIlikeWildcards('Reyna Alaburda, Ana Paula')).toBe('Reyna Alaburda, Ana Paula');
    expect(escapeIlikeWildcards('Peña')).toBe('Peña');
    expect(escapeIlikeWildcards('')).toBe('');
  });
});

describe('hasSearchableContent', () => {
  it('🔒 termo feito SÓ de curinga não é busca', () => {
    expect(hasSearchableContent('%%')).toBe(false);
    expect(hasSearchableContent('__')).toBe(false);
    expect(hasSearchableContent('%_')).toBe(false);
    expect(hasSearchableContent('\\\\')).toBe(false);
    expect(hasSearchableContent('% %')).toBe(false);
  });

  it('uma letra junto do curinga já é conteúdo — o filtro é de alcance, não de estilo', () => {
    expect(hasSearchableContent('a%')).toBe(true);
    expect(hasSearchableContent('%Ana%')).toBe(true);
  });

  it('nome comum passa', () => {
    expect(hasSearchableContent('Reyna')).toBe(true);
  });
});
