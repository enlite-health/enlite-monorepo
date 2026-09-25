/**
 * PatientStatus v2 (spec 012, US-B7 — decisão 2 do Gabriel, 03/09): seis estados clínicos +
 * o funil de admissão em coluna própria. DISCONTINUED sai do vocabulário (backfill → DISCHARGED,
 * migration 314); ON_HOLD exige motivo (SCHOOL | INSURER | OTHER).
 */
import {
  PATIENT_STATUSES, CLINICAL_PATIENT_STATUSES, ADMISSION_FUNNEL_STATUSES,
  isPatientStatus, isClinicalPatientStatus, isAdmissionFunnelStatus,
} from '../PatientStatus';
import { ON_HOLD_REASONS, isOnHoldReason } from '../OnHoldReason';
import { ADMISSION_STATUSES, isAdmissionStatus } from '../AdmissionStatus';

describe('PatientStatus v2', () => {
  it('os sete estados clínicos são exatamente os da decisão 2', () => {
    expect([...CLINICAL_PATIENT_STATUSES].sort()).toEqual(
      ['ACTIVE', 'ALTA', 'DISCHARGED', 'ON_HOLD', 'REPLACEMENT', 'SEARCHING', 'SUSPENDED'],
    );
  });

  it('o funil de admissão continua aceito em `status` (legado até o backfill; o Kanban lê admission_status)', () => {
    expect([...ADMISSION_FUNNEL_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION']);
    expect(PATIENT_STATUSES).toEqual([...ADMISSION_FUNNEL_STATUSES, ...CLINICAL_PATIENT_STATUSES]);
  });

  it('DISCONTINUED NÃO é mais status válido (migration 314 o converte em DISCHARGED)', () => {
    expect(isPatientStatus('DISCONTINUED')).toBe(false);
    expect(isPatientStatus('ON_HOLD')).toBe(true);
    expect(isClinicalPatientStatus('ADMISSION')).toBe(false);
    expect(isClinicalPatientStatus('SEARCHING')).toBe(true);
    expect(isClinicalPatientStatus('ALTA')).toBe(true);
    expect(isClinicalPatientStatus(42)).toBe(false);
  });

  it('OnHoldReason = SCHOOL | INSURER | OTHER; AdmissionStatus = funil + DONE', () => {
    expect([...ON_HOLD_REASONS]).toEqual(['SCHOOL', 'INSURER', 'OTHER']);
    expect(isOnHoldReason('INSURER')).toBe(true);
    expect(isOnHoldReason('insurer')).toBe(false);
    expect([...ADMISSION_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', 'DONE']);
    expect(isAdmissionStatus('DONE')).toBe(true);
    expect(isAdmissionStatus('ACTIVE')).toBe(false);
  });

  it('isAdmissionFunnelStatus distingue funil de estado clínico', () => {
    expect(isAdmissionFunnelStatus('SOLICITANTE')).toBe(true);
    expect(isAdmissionFunnelStatus('ON_HOLD')).toBe(false);
    expect(isAdmissionFunnelStatus(null)).toBe(false);
  });
});
