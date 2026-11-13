/**
 * patientRef — spec 077 FR-39: mesmo paciente → mesmo ref; pacientes distintos → refs distintos; o ref nunca é o id.
 * Ids sintéticos.
 */
import { patientRefOf, PATIENT_REF_NAMESPACE } from '../patientRef';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('patientRefOf', () => {
  it('T-F2a-01 mesmo patient_id → mesmo ref entre chamadas (estável entre pulls)', () => {
    expect(patientRefOf(P1)).toBe(patientRefOf(P1));
  });

  it('T-F2a-01 valor fixado: namespace e algoritmo não mudam sem quebrar este caso', () => {
    expect(PATIENT_REF_NAMESPACE).toBe('b1c7f0e2-6d3a-5f4e-9a1b-077000000001');
    expect(patientRefOf(P1)).toBe('9f103f86-26dc-53ac-8c3a-92951d0e0537');
  });

  it('T-F2a-01 dois patient_id → dois refs distintos', () => {
    expect(patientRefOf(P1)).not.toBe(patientRefOf(P2));
  });

  it('T-F2a-01 o ref nunca é o patient_id nem o contém', () => {
    expect(patientRefOf(P1)).not.toBe(P1);
    expect(patientRefOf(P1)).not.toContain('aaaaaaaa');
  });

  it('T-F2a-01 formato uuid v5', () => {
    expect(patientRefOf(P1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
