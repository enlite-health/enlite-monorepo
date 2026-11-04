import { foldText, tokenizeQuery, MAX_SEARCH_TOKENS } from '../searchTokens';

describe('foldText', () => {
  it('minúsculas, sem acento (ñ→n) e espaços colapsados', () => {
    expect(foldText('  Depresión   ÑANDÚ ')).toBe('depresion nandu');
  });
});

describe('tokenizeQuery', () => {
  it('separa por espaço e pontuação, normaliza e descarta stopwords do ES', () => {
    expect(tokenizeQuery('Trastorno del desarrollo intelectual, leve')).toEqual([
      'trastorno',
      'desarrollo',
      'intelectual',
      'leve',
    ]);
  });

  it('descarta palavra de 1 caractere e repetição', () => {
    expect(tokenizeQuery('vitamina b 12 12')).toEqual(['vitamina', '12']);
  });

  it('só stopwords/pontuação → lista vazia (quem chama cai na frase inteira)', () => {
    expect(tokenizeQuery('de la')).toEqual([]);
    expect(tokenizeQuery('sin, con')).toEqual([]);
  });

  it('limita o número de palavras', () => {
    const muitas = Array.from({ length: 20 }, (_, i) => `palavra${i}`).join(' ');
    expect(tokenizeQuery(muitas)).toHaveLength(MAX_SEARCH_TOKENS);
  });
});
