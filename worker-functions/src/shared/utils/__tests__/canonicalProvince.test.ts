import { canonicalProvince } from '../normalizeLocationValue';

describe('canonicalProvince', () => {
  it('inglês "X Province" → "X"', () => {
    expect(canonicalProvince('Córdoba Province')).toBe('Córdoba');
    expect(canonicalProvince('Entre Ríos Province')).toBe('Entre Ríos');
  });

  it('"Buenos Aires Province" → "Provincia de Buenos Aires"', () => {
    expect(canonicalProvince('Buenos Aires Province')).toBe('Provincia de Buenos Aires');
    expect(canonicalProvince('Provincia de Buenos Aires')).toBe('Provincia de Buenos Aires');
  });

  it('"Buenos Aires" cru desambigua pela localidad', () => {
    // city = a cidade "Buenos Aires" → CABA
    expect(canonicalProvince('Buenos Aires', 'Buenos Aires')).toBe('Ciudad Autónoma de Buenos Aires');
    // outra localidad (partido) → provincia
    expect(canonicalProvince('Buenos Aires', 'La Matanza')).toBe('Provincia de Buenos Aires');
    expect(canonicalProvince('Buenos Aires')).toBe('Provincia de Buenos Aires');
  });

  it('variações de CABA → canônico', () => {
    expect(canonicalProvince('CABA')).toBe('Ciudad Autónoma de Buenos Aires');
    expect(canonicalProvince('Capital Federal')).toBe('Ciudad Autónoma de Buenos Aires');
    expect(canonicalProvince('Ciudad Autónoma de Buenos Aires')).toBe('Ciudad Autónoma de Buenos Aires');
  });

  it('outras provincias e vazios ficam inalterados', () => {
    expect(canonicalProvince('Chaco')).toBe('Chaco');
    expect(canonicalProvince('Tucumán')).toBe('Tucumán');
    expect(canonicalProvince('')).toBe('');
    expect(canonicalProvince(null)).toBeNull();
    expect(canonicalProvince(undefined)).toBeNull();
  });
});
