import { describe, it, expect } from 'vitest';
import { normalizeLooseTables } from '../normalizeLooseTables';

const LOOSE = [
  '| Item | Status |', '', '|---|---|', '', '| a | ✅ |', '', '| b | ✅ |',
].join('\n');

describe('normalizeLooseTables', () => {
  it('N1 grupo com delimitador perde as linhas em branco entre as linhas', () => {
    const content = [
      '| Item | Status | Detalhe |', '', '|---|---|---|', '', '| 1 | ✅ | x |', '', '| 2 | ✅ | x |',
      '', '| 3 | ✅ | x |', '', '| 4 | ✅ | x |', '', '| 5 | ✅ | x |', '', '| 6 | ✅ | x |',
    ].join('\n');
    const out = normalizeLooseTables(content).split('\n');
    expect(out).toHaveLength(8);
    expect(out.every((l) => l.startsWith('|'))).toBe(true);
  });

  it('N1b delimitador com dois-pontos e sem pipe final também vale', () => {
    expect(normalizeLooseTables('| a | b\n\n| :---: | ---:\n\n| 1 | 2')).toBe('| a | b\n| :---: | ---:\n| 1 | 2');
    expect(normalizeLooseTables('| a | b |\n\n| :--- | :---: |\n\n| 1 | 2 |')).toBe('| a | b |\n| :--- | :---: |\n| 1 | 2 |');
  });

  it('N2 sem delimitador fica inalterado', () => {
    const s = '| a | b |\n\n| 1 | 2 |';
    expect(normalizeLooseTables(s)).toBe(s);
  });

  it('N3 dentro de bloco cercado fica inalterado (``` e ~~~)', () => {
    const a = '```\n' + LOOSE + '\n```';
    const b = '~~~\n' + LOOSE + '\n~~~';
    expect(normalizeLooseTables(a)).toBe(a);
    expect(normalizeLooseTables(b)).toBe(b);
  });

  it('N4 parágrafo entre duas tabelas mantém as duas separadas', () => {
    const s = '| a |\n|---|\n| 1 |\n\ntexto\n\n| b |\n|---|\n| 2 |';
    expect(normalizeLooseTables(s)).toBe(s);
  });

  it('N5 texto sem pipe devolve a mesma string', () => {
    const s = 'um\n\ndois\n\n- tres';
    expect(normalizeLooseTables(s)).toBe(s);
  });

  it('N6 \\r\\n: tabela solta é normalizada e a linha em branco some', () => {
    const out = normalizeLooseTables(LOOSE.replace(/\n/g, '\r\n'));
    expect(out.split('\n')).toHaveLength(4);
    expect(out.split('\n').every((l) => l.trim().startsWith('|'))).toBe(true);
  });
});
