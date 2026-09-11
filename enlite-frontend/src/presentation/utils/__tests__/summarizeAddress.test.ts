import { describe, it, expect } from 'vitest';
import { summarizeAddress, streetLineOf, addressLines } from '../summarizeAddress';

describe('summarizeAddress', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(summarizeAddress(null)).toBe('');
    expect(summarizeAddress(undefined)).toBe('');
    expect(summarizeAddress('')).toBe('');
    expect(summarizeAddress('   ')).toBe('');
  });

  it('summarises Argentinian-style address with postal prefix', () => {
    expect(
      summarizeAddress(
        'Av. Italia 736, B1648EEU Tigre, Provincia de Buenos Aires, Argentina',
      ),
    ).toBe('Tigre, Provincia de Buenos Aires');
  });

  it('summarises Argentinian-style address without recognised street prefix', () => {
    expect(
      summarizeAddress(
        'Eva Perón 1536, B1824IAJ Lanús, Provincia de Buenos Aires, Argentina',
      ),
    ).toBe('Lanús, Provincia de Buenos Aires');
  });

  it('summarises CABA address', () => {
    expect(
      summarizeAddress(
        'Arenales 2111, C1124AAG Cdad. Autónoma de Buenos Aires, Argentina',
      ),
    ).toBe('Cdad. Autónoma de Buenos Aires');
  });

  it('summarises Brazilian-style address with separate number segment', () => {
    expect(
      summarizeAddress('Rua Augusta, 975, Consolação, São Paulo - SP, Brasil'),
    ).toBe('Consolação, São Paulo - SP');
  });

  it('strips Brazilian CEP', () => {
    expect(
      summarizeAddress(
        'Rua Augusta, 975, Consolação, São Paulo - SP, 01305-100, Brasil',
      ),
    ).toBe('Consolação, São Paulo - SP');
  });

  it('returns empty when the input is just street + number', () => {
    expect(summarizeAddress('Rua Augusta, 975')).toBe('');
    expect(summarizeAddress('Av. Italia 736')).toBe('');
  });

  it('passes through an already-summarised string', () => {
    expect(summarizeAddress('Consolação, São Paulo - SP')).toBe(
      'Consolação, São Paulo - SP',
    );
    expect(summarizeAddress('Tigre, Provincia de Buenos Aires')).toBe(
      'Tigre, Provincia de Buenos Aires',
    );
  });

  it('keeps locality when country is the only trailing token', () => {
    expect(summarizeAddress('Tigre, Argentina')).toBe('Tigre');
  });

  it('does not drop the only segment if it is a country (degenerate input)', () => {
    expect(summarizeAddress('Argentina')).toBe('Argentina');
  });

  it('handles "R." abbreviation', () => {
    expect(
      summarizeAddress('R. Augusta, 975, Consolação, São Paulo - SP, Brasil'),
    ).toBe('Consolação, São Paulo - SP');
  });

  // ── Achado do gate revisao-pr (spec Localizaciones Fase 1) ──────────────────────────────
  // O formato REAL que o Google devolve para BR não separa número e bairro em segmentos —
  // vêm juntos, unidos por " - " ("975 - Consolação"), diferente do "975" solto que os testes
  // acima usam. Sem tratar este caso, o número vazava para o resumo de localidade.
  it('summarises Brazilian-style address with number+neighborhood in the SAME segment (formato real do Google)', () => {
    expect(
      summarizeAddress('R. Augusta, 975 - Consolação, São Paulo - SP, Brasil'),
    ).toBe('Consolação, São Paulo - SP');
  });

  it('strips Brazilian CEP com número+bairro no mesmo segmento', () => {
    expect(
      summarizeAddress('R. Augusta, 975 - Consolação, São Paulo - SP, 01305-100, Brasil'),
    ).toBe('Consolação, São Paulo - SP');
  });

  it('"975 -" sem nada depois do traço não casa o padrão número+resto (falta o \\.+ exigido) — trata como segmento não reconhecido', () => {
    // Não é o caso real do Google (que sempre tem o bairro depois do traço) — documenta o
    // limite deliberado do regex: sem conteúdo após "-", cai no fallback (rest inclui o
    // segmento inteiro, sem separar número).
    expect(
      summarizeAddress('R. Augusta, 975 -, São Paulo - SP, Brasil'),
    ).toBe('975 -, São Paulo - SP');
  });
});

describe('streetLineOf', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(streetLineOf(null)).toBe('');
    expect(streetLineOf(undefined)).toBe('');
    expect(streetLineOf('')).toBe('');
    expect(streetLineOf('   ')).toBe('');
  });

  it('AR: rua + número já vêm no mesmo (1º) segmento', () => {
    expect(streetLineOf('Av. Corrientes 1234, C1043AAZ CABA, Argentina')).toBe('Av. Corrientes 1234');
    expect(streetLineOf('Av. Italia 736, B1648EEU Tigre, Provincia de Buenos Aires, Argentina')).toBe('Av. Italia 736');
  });

  it('BR: número como segmento à parte ("Rua Augusta", "975")', () => {
    expect(streetLineOf('Rua Augusta, 975, Consolação, São Paulo - SP, Brasil')).toBe('Rua Augusta, 975');
  });

  it('BR real: número + bairro no MESMO segmento ("975 - Consolação") — o achado do gate', () => {
    expect(streetLineOf('R. Augusta, 975 - Consolação, São Paulo - SP, Brasil')).toBe('R. Augusta, 975');
  });

  it('sem padrão de rua reconhecido, devolve o 1º segmento (nunca vazio com entrada não-vazia)', () => {
    expect(streetLineOf('Consolação, São Paulo - SP')).toBe('Consolação');
    expect(streetLineOf('Endereço sem vírgula nenhuma')).toBe('Endereço sem vírgula nenhuma');
  });

  it('texto que começa com vírgula: o segmento vazio inicial é descartado, não vira linha vazia', () => {
    expect(streetLineOf(', CABA, Argentina')).toBe('CABA');
  });

  it('só rua, sem número (degenerado) — devolve a rua', () => {
    expect(streetLineOf('Av. Italia 736')).toBe('Av. Italia 736');
    expect(streetLineOf('Rua Augusta, 975')).toBe('Rua Augusta, 975');
  });
});

// ── Achado MINOR do gate revisao-pr, 2ª rodada: paridade com origin/main ────────────────────
// Os 6 endereços AR abaixo têm resultado ESPERADO conferido rodando as duas versões de
// `summarizeAddress` lado a lado — a de origin/main (commit anterior a esta spec, colada num
// script `node` ad-hoc) e a atual — e comparando byte a byte (evidência no relatório do gate).
// AR nunca tem "número - bairro" no MESMO segmento (o caso que o BLOCKER/MAJOR mudou), então
// nenhum destes 6 deveria ter mudado — e não mudou.
describe('summarizeAddress — paridade com origin/main (endereços AR reais)', () => {
  it('Corrientes (CABA)', () => {
    expect(summarizeAddress('Av. Corrientes 1234, C1043AAZ Cdad. Autónoma de Buenos Aires, Argentina'))
      .toBe('Cdad. Autónoma de Buenos Aires');
  });

  it('Nordelta (barrio cerrado dentro de Tigre)', () => {
    expect(summarizeAddress('Av. de los Lagos 300, Nordelta, B1670 Tigre, Provincia de Buenos Aires, Argentina'))
      .toBe('Nordelta, Tigre, Provincia de Buenos Aires');
  });

  it('Tigre COM rua (não confundir com o caso sem rua da suíte addressLines)', () => {
    expect(summarizeAddress('Liniers 1250, B1648 Tigre, Provincia de Buenos Aires, Argentina'))
      .toBe('Tigre, Provincia de Buenos Aires');
  });

  it('La Plata com CEP B1900', () => {
    expect(summarizeAddress('Calle 7 1234, B1900 La Plata, Provincia de Buenos Aires, Argentina'))
      .toBe('La Plata, Provincia de Buenos Aires');
  });

  it('Rivadavia (CABA)', () => {
    expect(summarizeAddress('Av. Rivadavia 5000, C1424 Cdad. Autónoma de Buenos Aires, Argentina'))
      .toBe('Cdad. Autónoma de Buenos Aires');
  });

  it('Rosario com CEP S2000', () => {
    expect(summarizeAddress('Pellegrini 1500, S2000 Rosario, Santa Fe, Argentina'))
      .toBe('Rosario, Santa Fe');
  });
});

describe('addressLines', () => {
  it('AR real (Corrientes) — igual a streetLineOf + summarizeAddress somados, sem repetição (caso normal)', () => {
    expect(addressLines('Av. Corrientes 1234, C1043AAZ Cdad. Autónoma de Buenos Aires, Argentina'))
      .toEqual({ line1: 'Av. Corrientes 1234', line2: 'Cdad. Autónoma de Buenos Aires' });
  });

  it('BR real (achado MAJOR) — número não vaza pra linha 2', () => {
    expect(addressLines('R. Augusta, 975 - Consolação, São Paulo - SP, Brasil'))
      .toEqual({ line1: 'R. Augusta, 975', line2: 'Consolação, São Paulo - SP' });
  });

  // ── Achado MINOR do gate, 2ª rodada: linha 2 nunca repete a linha 1 ────────────────────────
  it('sem rua nenhuma reconhecida (só localidade): linha 2 NÃO repete a linha 1', () => {
    expect(addressLines('Tigre, Provincia de Buenos Aires, Argentina'))
      .toEqual({ line1: 'Tigre', line2: 'Provincia de Buenos Aires' });
  });

  it('"Barrio X" não é reconhecido como rua: linha 2 NÃO repete o barrio', () => {
    expect(addressLines('Barrio Los Pinos, Pilar, Buenos Aires, Argentina'))
      .toEqual({ line1: 'Barrio Los Pinos', line2: 'Pilar, Buenos Aires' });
  });

  // ── Achado MINOR do gate, 2ª rodada: país nunca vira linha 2 sozinho ───────────────────────
  it('país como único resto (COM rua reconhecida): linha 2 fica null, não "Argentina"', () => {
    expect(addressLines('Ruta 9 km 42, Argentina')).toEqual({ line1: 'Ruta 9 km 42', line2: null });
  });

  it('país como único resto (SEM rua reconhecida): linha 2 também fica null', () => {
    expect(addressLines('Tigre, Argentina')).toEqual({ line1: 'Tigre', line2: null });
  });

  it('só rua+número, sem nada mais: linha 2 fica null (mesmo caso de summarizeAddress)', () => {
    expect(addressLines('Rua Augusta, 975')).toEqual({ line1: 'Rua Augusta, 975', line2: null });
  });

  it('entrada vazia', () => {
    expect(addressLines(null)).toEqual({ line1: '', line2: null });
    expect(addressLines('')).toEqual({ line1: '', line2: null });
  });
});
