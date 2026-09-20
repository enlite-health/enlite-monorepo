import { PATIENT_GENDERS, isPatientGender } from '../PatientGender';
import { PATIENT_LANGUAGES, isPatientLanguage } from '../PatientLanguage';

describe('PatientGender / PatientLanguage (spec 018 PR-3, migration 425)', () => {
  it('isPatientGender aceita cada valor do enum e recusa lixo/tipo errado', () => {
    for (const g of PATIENT_GENDERS) expect(isPatientGender(g)).toBe(true);
    expect(isPatientGender('CATOLICO')).toBe(false);
    expect(isPatientGender(null)).toBe(false);
    expect(isPatientGender(123)).toBe(false);
  });

  it('isPatientLanguage aceita pt/es/en e recusa fora da lista fechada', () => {
    for (const l of PATIENT_LANGUAGES) expect(isPatientLanguage(l)).toBe(true);
    expect(isPatientLanguage('fr')).toBe(false);
    expect(isPatientLanguage(undefined)).toBe(false);
  });
});
