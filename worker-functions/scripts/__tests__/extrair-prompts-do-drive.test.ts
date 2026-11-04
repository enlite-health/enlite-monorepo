/**
 * extrair-prompts-do-drive.test.ts — a validação é o que impede uma página de erro do Drive
 * de virar "prompt válido" (spec 029, T047). Testável sem rede: só as funções puras.
 */
import { lerArgumentos, normalizar, sha256, validarConteudo } from '../extrair-prompts-do-drive';

describe('validarConteudo', () => {
  const longo = 'Regla 1: ' + 'x'.repeat(600);

  it('texto longo com marcador → sem motivos', () => {
    expect(validarConteudo('a.txt', longo, 500, 'Regla')).toEqual([]);
  });

  it('página de erro curta → reprova por tamanho', () => {
    const motivos = validarConteudo('a.txt', 'Error 404', 500, 'Regla');
    expect(motivos.some((m) => m.includes('< mínimo 500'))).toBe(true);
  });

  it('texto longo SEM o marcador (página HTML de erro longa) → reprova por marcador', () => {
    const motivos = validarConteudo('a.txt', '<html>' + 'y'.repeat(900), 500, 'Regla');
    expect(motivos).toEqual(["a.txt: marcador 'Regla' ausente"]);
  });

  it('curto E sem marcador → os dois motivos', () => {
    expect(validarConteudo('a.txt', 'oi', 500, 'Regla')).toHaveLength(2);
  });

  it('--min-chars absurdo reprova qualquer texto', () => {
    expect(validarConteudo('a.txt', longo, 999999, 'Regla')).not.toEqual([]);
  });
});

describe('normalizar', () => {
  it('remove o BOM e as bordas', () => {
    expect(normalizar('﻿  hola \n')).toBe('hola');
  });
  it('converte CRLF e CR solto em LF, depois do BOM e antes do trim', () => {
    expect(normalizar('\uFEFF\r\na\r\nb\rc\n\r\n')).toBe('a\nb\nc');
  });
  it('não deixa nenhum CR no resultado', () => {
    expect(normalizar('x\r\ny\rz\r\n')).not.toContain('\r');
  });
  it('não mexe no miolo (aspas, acentos, quebras)', () => {
    expect(normalizar('﻿a\n"b" \'c\' ñ\nd')).toBe('a\n"b" \'c\' ñ\nd');
  });
});

describe('sha256', () => {
  it('valor conhecido de "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('lerArgumentos', () => {
  const base = ['node', 's', '--out', '/tmp/x', '--min-chars', '500', '--exigir-marcador', 'Regla'];
  it('lê as três flags', () => {
    expect(lerArgumentos(base)).toEqual({ out: '/tmp/x', minChars: 500, marcador: 'Regla' });
  });
  it('flag ausente → erro', () => {
    expect(() => lerArgumentos(['node', 's', '--out', '/tmp/x'])).toThrow('--min-chars');
  });
  it('min-chars não numérico → erro', () => {
    expect(() => lerArgumentos(['node', 's', '--out', '/x', '--min-chars', 'abc', '--exigir-marcador', 'R'])).toThrow(
      'inteiro',
    );
  });
});
