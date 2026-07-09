/**
 * Unit da fonte de query do backfill de geocoding de worker_service_areas.
 * Garante: (1) sem address_line, a ZONA vira query coarse (os ~457 legados);
 * (2) address_line usa query precise com CPA-lixo removido.
 */
import { buildQuery, stripCpa } from '../../../scripts/backfill-worker-service-areas-geocoding';

type Row = Parameters<typeof buildQuery>[0];
const base: Row = {
  id: 'x', worker_id: 'w', address_line: null, neighborhood: null,
  city: null, state: null, work_zone: null, interest_zone: null,
  latitude: null, longitude: null,
};

describe('stripCpa', () => {
  it('remove CPA "B1832 AOO" e "C1426BSI"', () => {
    expect(stripCpa('Gral. Arenales 739, B1832 AOO, Provincia de Buenos Aires'))
      .toBe('Gral. Arenales 739, Provincia de Buenos Aires');
    expect(stripCpa('Arce 691, C1426BSI, Cdad. Autónoma')).toBe('Arce 691, Cdad. Autónoma');
  });
  it('remove CPA antigo "B1748"', () => {
    expect(stripCpa('Carlos Pellegrini 1676, B1748, Provincia')).toBe('Carlos Pellegrini 1676, Provincia');
  });
});

describe('buildQuery', () => {
  it('address_line já com país → precise, CPA removido', () => {
    const q = buildQuery({ ...base, address_line: 'Arce 691, C1426BSI, Cdad. Autónoma de Buenos Aires, Argentina' });
    expect(q).toEqual({ query: 'Arce 691, Cdad. Autónoma de Buenos Aires, Argentina', coarse: false });
  });

  it('address_line sem país compõe + Argentina, ignorando city-lixo', () => {
    const q = buildQuery({ ...base, address_line: 'Gral. Arenales 739, B1832 AOO', city: 'AOO', state: 'Provincia de Buenos Aires' });
    expect(q).toEqual({ query: 'Gral. Arenales 739, Provincia de Buenos Aires, Argentina', coarse: false });
  });

  it('sem address_line, work_zone vira query COARSE', () => {
    expect(buildQuery({ ...base, work_zone: 'La Matanza' })).toEqual({ query: 'La Matanza, Argentina', coarse: true });
  });

  it('sem address_line nem work_zone, usa interest_zone (coarse)', () => {
    expect(buildQuery({ ...base, interest_zone: 'Escobar' })).toEqual({ query: 'Escobar, Argentina', coarse: true });
  });

  it('sem nenhuma fonte → null', () => {
    expect(buildQuery(base)).toBeNull();
  });
});
