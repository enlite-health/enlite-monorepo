import { describe, it, expect } from 'vitest';
import { patientAddressLabel } from '../PatientContractedService';

describe('patientAddressLabel — mesmo fallback de LocalizacoesCard', () => {
  it('prefere o texto do geocoder, cai no texto cru, e por fim em "—"', () => {
    expect(patientAddressLabel({ addressFormatted: 'Rua A, 1', addressRaw: 'rua a 1' })).toBe('Rua A, 1');
    expect(patientAddressLabel({ addressFormatted: null, addressRaw: 'rua a 1' })).toBe('rua a 1');
    expect(patientAddressLabel({ addressFormatted: null, addressRaw: null })).toBe('—');
  });
});
