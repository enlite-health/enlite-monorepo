/**
 * accentFold.test.ts
 *
 * A régua é a SIMETRIA. Dobrar acento só de um lado da comparação é pior que
 * não dobrar: a busca continua funcionando para "Silva" e falha só para
 * "Peña" — defeito que passa despercebido justamente onde importa.
 */
import { ACCENT_FROM, ACCENT_TO, foldAccents, sqlFoldAccents } from '../accentFold';

describe('accentFold — a tabela', () => {
  it('🔒 FROM e TO têm o mesmo comprimento (senão `translate` trunca em silêncio)', () => {
    expect([...ACCENT_FROM]).toHaveLength([...ACCENT_TO].length);
  });

  it('🔒 nenhum caractere repetido no FROM — repetição faria a 2ª ocorrência ser ignorada', () => {
    expect(new Set([...ACCENT_FROM]).size).toBe([...ACCENT_FROM].length);
  });

  it('cobre o que o mercado escreve: ñ, ç e as vogais dos dois idiomas', () => {
    for (const ch of 'áéíóúñçãõâêôàüÁÉÍÓÚÑÇ') {
      expect(ACCENT_FROM).toContain(ch);
    }
  });
});

describe('foldAccents', () => {
  it('dobra os nomes que motivaram o conserto', () => {
    expect(foldAccents('Peña')).toBe('Pena');
    expect(foldAccents('García')).toBe('Garcia');
    expect(foldAccents('Muñoz')).toBe('Munoz');
    expect(foldAccents('Gonçalves')).toBe('Goncalves');
  });

  it('preserva maiúscula e o resto do texto', () => {
    expect(foldAccents('MUÑOZ')).toBe('MUNOZ');
    expect(foldAccents('Reyna Alaburda, Ana Paula')).toBe('Reyna Alaburda, Ana Paula');
    expect(foldAccents('')).toBe('');
  });

  it('não engole caractere fora da tabela', () => {
    expect(foldAccents("O'Higgins")).toBe("O'Higgins");
    expect(foldAccents('Ana-Paz 3º')).toBe('Ana-Paz 3º');
  });
});

describe('sqlFoldAccents', () => {
  it('embrulha a expressão num translate com a MESMA tabela do lado JS', () => {
    const sql = sqlFoldAccents('p.first_name');
    expect(sql).toBe(`translate(p.first_name, '${ACCENT_FROM}', '${ACCENT_TO}')`);
  });

  it('🔒 SIMETRIA: o `translate` gerado trata cada caractere igual ao `foldAccents`', () => {
    // reproduz o `translate` do Postgres em JS, a partir do texto SQL emitido —
    // se as duas pontas divergirem em UM caractere, isto reprova.
    const sql = sqlFoldAccents('col');
    const [, from, to] = sql.match(/translate\(col, '(.*)', '(.*)'\)$/) as RegExpMatchArray;
    const comoOPostgresFaria = (s: string): string =>
      [...s].map((ch) => (from.indexOf(ch) === -1 ? ch : to[from.indexOf(ch)])).join('');

    for (const ch of ACCENT_FROM) {
      expect(comoOPostgresFaria(ch)).toBe(foldAccents(ch));
    }
    for (const nome of ['Peña', 'García', 'Gonçalves', 'MUÑOZ', "O'Higgins", 'Ana Paz']) {
      expect(comoOPostgresFaria(nome)).toBe(foldAccents(nome));
    }
  });
});
