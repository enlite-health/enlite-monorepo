import { describe, it, expect } from 'vitest';
import { summarizeAddress, streetLineOf } from '../summarizeAddress';

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
