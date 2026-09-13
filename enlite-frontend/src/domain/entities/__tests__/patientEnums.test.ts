/**
 * patientEnums — os vocabulários do bloco B (spec 012) que a tela traduz.
 * A fonte da verdade do CATÁLOGO de cobertura é o banco (insurance_providers, editável sem
 * deploy); a lista daqui é o SEED dos 33 do contrato 001 — serve ao teste de cobertura de i18n,
 * e o select cai no próprio código quando aparece um novo (t(key, code)).
 */
import { describe, it, expect } from 'vitest';
import {
  CLINICAL_PATIENT_STATUSES, ADMISSION_FUNNEL_STATUSES, PATIENT_STATUSES, ON_HOLD_REASONS,
  ADMISSION_STATUSES, INSURANCE_PROVIDER_CODES, DEVICE_TYPE_CODES, RELATIONSHIP_CODES,
} from '../patientEnums';

describe('patientEnums (spec 012)', () => {
  it('PatientStatus v2: 6 clínicos + 3 do funil; DISCONTINUED saiu', () => {
    expect([...CLINICAL_PATIENT_STATUSES]).toEqual(['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'DISCHARGED']);
    expect([...ADMISSION_FUNNEL_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION']);
    expect(PATIENT_STATUSES).toHaveLength(9);
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

  it('os 33 códigos de cobertura do contrato 001 (§Enums canônicos), sem duplicata', () => {
    expect(INSURANCE_PROVIDER_CODES).toHaveLength(33);
    expect(new Set(INSURANCE_PROVIDER_CODES).size).toBe(33);
    for (const c of ['API', 'OSDE', 'SWISS_MEDICAL', 'HTAL_BRITANICO', 'OGORMAN', 'PFA_SUPERINTENDENCIA', 'PRIVATE', 'OTHER', 'IOSCOR']) {
      expect(INSURANCE_PROVIDER_CODES).toContain(c);
    }
    for (const c of INSURANCE_PROVIDER_CODES) expect(c).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
