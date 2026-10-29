import { isReliableGeocode, geocodeQualityLabel } from '../geocodeQuality';

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
