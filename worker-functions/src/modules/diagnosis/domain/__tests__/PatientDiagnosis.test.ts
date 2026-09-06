import { IcdCode } from '../../../terminology/domain/IcdCode';
import { DiagnosisSource } from '../DiagnosisSource';
import { PatientDiagnosis, InvalidPatientDiagnosisStateError, DiagnosisNotActiveError } from '../PatientDiagnosis';

function baseProps(overrides: Partial<Parameters<typeof PatientDiagnosis.reconstruct>[0]> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    patientId: '22222222-2222-2222-2222-222222222222',
    terminologySystem: 'ICD-11' as const,
    conceptUri: 'http://id.who.int/icd/release/11/2026-01/mms/123',
    // Byte-idêntico ao cluster pós-coordenado — NUNCA truncado (F0).
    conceptCode: IcdCode.parse('6A02.Z&XS5W'),
    conceptTitle: 'Trastorno del espectro autista',
    conceptLanguage: 'es' as const,
    conceptGroup: '06',
    catalogRelease: '2026-01',
    source: DiagnosisSource.PANEL,
    isPrimary: true,
    active: true,
    endedAt: null,
    country: 'AR' as const,
    createdBy: 'uid-1',
    updatedBy: 'uid-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PatientDiagnosis — Entity, invariantes de linha (spec 016 F2)', () => {
  it('reconstrói com os campos íntegros, código INTEIRO nunca truncado', () => {
    const props = baseProps();
    const d = PatientDiagnosis.reconstruct(props);
    expect(d.id).toBe(props.id);
    expect(d.patientId).toBe(props.patientId);
    expect(d.terminologySystem).toBe('ICD-11');
    expect(d.conceptUri).toBe(props.conceptUri);
    expect(d.conceptCode.value).toBe('6A02.Z&XS5W');
    expect(d.conceptTitle).toBe('Trastorno del espectro autista');
    expect(d.conceptLanguage).toBe('es');
    expect(d.conceptGroup).toBe('06');
    expect(d.catalogRelease).toBe('2026-01');
    expect(d.source.equals(DiagnosisSource.PANEL)).toBe(true);
    expect(d.isPrimary).toBe(true);
    expect(d.active).toBe(true);
    expect(d.endedAt).toBeNull();
    expect(d.country).toBe('AR');
    expect(d.createdBy).toBe('uid-1');
    expect(d.updatedBy).toBe('uid-1');
    expect(d.createdAt).toEqual(props.createdAt);
    expect(d.updatedAt).toEqual(props.updatedAt);
  });

  it('rejeita active=true com endedAt preenchido (mesmo CHECK pd_active_ended_coerente)', () => {
    expect(() => PatientDiagnosis.reconstruct(baseProps({ active: true, endedAt: new Date() }))).toThrow(
      InvalidPatientDiagnosisStateError,
    );
  });

  it('rejeita active=false sem endedAt (mesmo CHECK pd_active_ended_coerente)', () => {
    expect(() => PatientDiagnosis.reconstruct(baseProps({ active: false, endedAt: null }))).toThrow(
      InvalidPatientDiagnosisStateError,
    );
  });

  it('rejeita isPrimary=true com active=false (mesmo CHECK pd_primary_so_se_ativo)', () => {
    expect(() =>
      PatientDiagnosis.reconstruct(baseProps({ active: false, endedAt: new Date(), isPrimary: true })),
    ).toThrow(InvalidPatientDiagnosisStateError);
  });

  it('aceita isPrimary=false com active=false — desativado e não-principal é coerente', () => {
    const d = PatientDiagnosis.reconstruct(baseProps({ active: false, endedAt: new Date(), isPrimary: false }));
    expect(d.active).toBe(false);
    expect(d.isPrimary).toBe(false);
  });

  it('assertCanBecomePrimary passa quando ativo', () => {
    const d = PatientDiagnosis.reconstruct(baseProps({ isPrimary: false }));
    expect(() => d.assertCanBecomePrimary()).not.toThrow();
  });

  it('assertCanBecomePrimary lança DiagnosisNotActiveError quando inativo', () => {
    const d = PatientDiagnosis.reconstruct(baseProps({ active: false, endedAt: new Date(), isPrimary: false }));
    expect(() => d.assertCanBecomePrimary()).toThrow(DiagnosisNotActiveError);
  });

  it('assertCanDeactivate lança DiagnosisNotActiveError quando já inativo (evita 2ª baixa silenciosa)', () => {
    const d = PatientDiagnosis.reconstruct(baseProps({ active: false, endedAt: new Date(), isPrimary: false }));
    expect(() => d.assertCanDeactivate()).toThrow(DiagnosisNotActiveError);
  });

  it('assertCanDeactivate passa quando ativo', () => {
    const d = PatientDiagnosis.reconstruct(baseProps());
    expect(() => d.assertCanDeactivate()).not.toThrow();
  });

  it('belongsToPatient confere posse — base do 404 cross-patient no caso de uso', () => {
    const d = PatientDiagnosis.reconstruct(baseProps());
    expect(d.belongsToPatient('22222222-2222-2222-2222-222222222222')).toBe(true);
    expect(d.belongsToPatient('outro-paciente')).toBe(false);
  });
});
