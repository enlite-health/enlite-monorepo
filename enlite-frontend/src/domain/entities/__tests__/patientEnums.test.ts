/**
 * patientEnums — os vocabulários do bloco B (spec 012) que a tela traduz.
 * O CATÁLOGO de cobertura é do banco (insurance_providers, com o nome; spec 058 C3): não há mais lista de códigos nem
 * tradução por código no front (a constante dos 33 saiu).
 */
import { describe, it, expect } from 'vitest';
import {
  CLINICAL_PATIENT_STATUSES, ADMISSION_FUNNEL_STATUSES, PATIENT_STATUSES, ON_HOLD_REASONS,
  ADMISSION_STATUSES, DEVICE_TYPE_CODES, RELATIONSHIP_CODES,
} from '../patientEnums';

describe('patientEnums (spec 012)', () => {
  it('PatientStatus v2: 7 clínicos (ALTA entrou na migration 498, D430) + 3 do funil; DISCONTINUED saiu', () => {
    expect([...CLINICAL_PATIENT_STATUSES]).toEqual(['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'ALTA', 'DISCHARGED']);
    expect([...ADMISSION_FUNNEL_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION']);
    expect(PATIENT_STATUSES).toHaveLength(10);
    expect(PATIENT_STATUSES).not.toContain('DISCONTINUED');
  });

  it('motivo de espera, funil de admissão (coluna do Kanban), dispositivo, parentesco', () => {
    expect([...ON_HOLD_REASONS]).toEqual(['SCHOOL', 'INSURER', 'OTHER']);
    expect([...ADMISSION_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', 'DONE']);
    expect([...DEVICE_TYPE_CODES]).toEqual(['HOME', 'SCHOOL', 'INSTITUTIONAL', 'INPATIENT', 'TRANSPORT']);
    expect([...RELATIONSHIP_CODES]).toEqual([
      'CHILD', 'PARENT', 'SIBLING', 'NEPHEW', 'GRANDCHILD', 'GUARDIAN', 'FRIEND', 'PARTNER', 'OTHER',
      'GRANDPARENT', 'UNCLE_AUNT', 'COUSIN', 'IN_LAW', 'STEP_RELATIVE', 'RESPONSIBLE_PERSON',
    ]); // ampliado na migration 421 (spec 018, PR-2, SUP-16)
  });
});
