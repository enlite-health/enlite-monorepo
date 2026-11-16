import { isReliableGeocode, geocodeQualityLabel, isCheckinReliable } from '../geocodeQuality';

describe('isReliableGeocode', () => {
  it('ROOFTOP + partialMatch=false -> true', () => expect(isReliableGeocode('ROOFTOP', false)).toBe(true));
  it('RANGE_INTERPOLATED + partialMatch=false -> true', () =>
    expect(isReliableGeocode('RANGE_INTERPOLATED', false)).toBe(true));
  it('ROOFTOP + partialMatch=true -> false', () => expect(isReliableGeocode('ROOFTOP', true)).toBe(false));
  it('RANGE_INTERPOLATED + partialMatch=true -> false', () =>
    expect(isReliableGeocode('RANGE_INTERPOLATED', true)).toBe(false));
  it('GEOMETRIC_CENTER -> false', () => expect(isReliableGeocode('GEOMETRIC_CENTER', false)).toBe(false));
  it('APPROXIMATE -> false', () => expect(isReliableGeocode('APPROXIMATE', false)).toBe(false));
  it('UNKNOWN -> false', () => expect(isReliableGeocode('UNKNOWN', false)).toBe(false));
  it('null / undefined locationType -> false', () => {
    expect(isReliableGeocode(null, false)).toBe(false);
    expect(isReliableGeocode(undefined, undefined)).toBe(false);
  });
  it('ROOFTOP + partialMatch undefined/null -> true', () => {
    expect(isReliableGeocode('ROOFTOP', undefined)).toBe(true);
    expect(isReliableGeocode('ROOFTOP', null)).toBe(true);
  });
});

describe('geocodeQualityLabel', () => {
  it('RELIABLE / UNRELIABLE', () => {
    expect(geocodeQualityLabel('ROOFTOP', false)).toBe('RELIABLE');
    expect(geocodeQualityLabel('ROOFTOP', true)).toBe('UNRELIABLE');
    expect(geocodeQualityLabel('APPROXIMATE', false)).toBe('UNRELIABLE');
  });
});

describe('isCheckinReliable (D718)', () => {
  it('T-F0b-44 classificado, inclusive aproximado e UNKNOWN = true', () => {
    for (const t of ['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER', 'APPROXIMATE', 'UNKNOWN'] as const) {
      expect(isCheckinReliable(t)).toBe(true);
    }
  });
  it('T-F0b-44 ainda não classificado (null ou undefined) = false', () => {
    expect(isCheckinReliable(null)).toBe(false);
    expect(isCheckinReliable(undefined)).toBe(false);
  });
});
