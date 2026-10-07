import { describe, it, expect } from 'vitest';
import { deriveBillingLocality } from './deriveBillingLocality';

// Fixtures inline, endereço fictício, no formato do widget do Google Places.
const COMPONENTES = [
  { long_name: '123', short_name: '123', types: ['street_number'] },
  { long_name: 'Calle Falsa', short_name: 'Calle Falsa', types: ['route'] },
  { long_name: 'Barrio Ficticio', short_name: 'B. Ficticio', types: ['sublocality_level_1', 'sublocality', 'political'] },
  { long_name: 'Ciudad Ficticia', short_name: 'C. Ficticia', types: ['locality', 'political'] },
  { long_name: 'Provincia Ficticia', short_name: 'PF', types: ['administrative_area_level_1', 'political'] },
  { long_name: 'Argentina', short_name: 'AR', types: ['country', 'political'] },
];

describe('deriveBillingLocality (spec 044, P3)', () => {
  it('cidade = locality, província = administrative_area_level_1, pelo long_name', () => {
    expect(deriveBillingLocality(COMPONENTES)).toEqual({ city: 'Ciudad Ficticia', province: 'Provincia Ficticia' });
  });

  it('sem long_name cai no short_name; nome em branco conta como ausente', () => {
    expect(deriveBillingLocality([
      { short_name: ' CF ', types: ['locality'] },
      { long_name: '   ', types: ['administrative_area_level_1'] },
    ])).toEqual({ city: 'CF', province: null });
  });

  it('componente ausente → null (sem fallback para sublocality, administrative_area_level_2 etc.)', () => {
    expect(deriveBillingLocality([
      { long_name: 'Barrio Ficticio', types: ['sublocality_level_1'] },
      { long_name: 'Partido Ficticio', types: ['administrative_area_level_2'] },
    ])).toEqual({ city: null, province: null });
  });

  it('entrada nula, indefinida ou fora de array → ambos null', () => {
    expect(deriveBillingLocality(null)).toEqual({ city: null, province: null });
    expect(deriveBillingLocality(undefined)).toEqual({ city: null, province: null });
    expect(deriveBillingLocality({} as never)).toEqual({ city: null, province: null });
  });

  it('componente sem types é ignorado; vale o PRIMEIRO que bate', () => {
    expect(deriveBillingLocality([
      { long_name: 'Sem Tipos' } as never,
      { long_name: 'Primeira', types: ['locality'] },
      { long_name: 'Segunda', types: ['locality'] },
    ])).toEqual({ city: 'Primeira', province: null });
  });
});
