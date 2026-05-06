import { describe, it, expect } from 'vitest';
import { summarizeAddress } from '../summarizeAddress';

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
});
