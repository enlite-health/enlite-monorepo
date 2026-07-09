/**
 * Unit da fonte de query do backfill de geocoding de worker_service_areas.
 * Garante que, sem address_line, a ZONA de texto livre (work_zone/interest_zone)
 * vira a query — o caso dos ~457 imports legados que o script antigo ignorava.
 */
import { buildQuery } from '../../../scripts/backfill-worker-service-areas-geocoding';

type Row = Parameters<typeof buildQuery>[0];
const base: Row = {
  id: 'x', worker_id: 'w', address_line: null, neighborhood: null,
  city: null, state: null, work_zone: null, interest_zone: null,
  latitude: null, longitude: null,
};

describe('buildQuery', () => {
  it('usa address_line já formatado (contém país) direto', () => {
    expect(buildQuery({ ...base, address_line: 'Av. Santa Fe 3681, CABA, Argentina' }))
      .toBe('Av. Santa Fe 3681, CABA, Argentina');
  });

  it('compõe address_line + componentes + país quando não tem país', () => {
    expect(buildQuery({ ...base, address_line: 'Calle 1', neighborhood: 'Centro', city: 'Quilmes', state: 'Buenos Aires' }))
      .toBe('Calle 1, Centro, Quilmes, Buenos Aires, Argentina');
  });

  it('sem address_line, cai na work_zone', () => {
    expect(buildQuery({ ...base, work_zone: 'Flores' })).toBe('Flores, Argentina');
  });

  it('sem address_line nem work_zone, usa interest_zone', () => {
    expect(buildQuery({ ...base, interest_zone: 'En CABA, zona norte' })).toBe('En CABA, zona norte, Argentina');
  });

  it('work_zone tem prioridade sobre interest_zone', () => {
    expect(buildQuery({ ...base, work_zone: 'Avellaneda', interest_zone: 'Lanús' })).toBe('Avellaneda, Argentina');
  });

  it('sem nenhuma fonte → null', () => {
    expect(buildQuery(base)).toBeNull();
  });
});
