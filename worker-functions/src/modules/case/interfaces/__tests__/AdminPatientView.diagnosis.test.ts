/**
 * `patientDetailCompleteness` (GET /patients/:id) com o DIAGNOSIS (pedido do Javier): o checklist da
 * ficha lê a contagem de diagnósticos ATIVOS do detalhe (nunca o valor) e a projeta por container —
 * quem não lê `patient_clinical` recebe o genérico CLINICAL_DATA, nunca `[]`/ausência (que diria "tem").
 */
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: jest.fn() } }));
jest.mock('@shared/security/KMSEncryptionService', () => ({ KMSEncryptionService: jest.fn() }));

import { patientDetailCompleteness } from '../AdminPatientView';

/** Ficha COMPLETA nos outros 7 itens: só o diagnóstico decide `missing`. */
const base = {
  birthDate: '1980-01-01',
  hasConsent: true,
  insuranceInformed: 'OSDE',
  addresses: [{ id: 'a1' }],
  responsibles: [],
  contractedServices: [{ active: true, addressId: 'a1', schedule: [{ d: 1 }] }],
};

const LE = ['patient:read', 'patient_clinical:read', 'patient_address:read', 'patient_services:read', 'patient_family:read', 'patient_coverage:read', 'patient_identity:read'];
const NAO_LE = LE.filter((c) => c !== 'patient_clinical:read');

describe('patientDetailCompleteness — DIAGNOSIS', () => {
  it('ADMISSION com 0 diagnósticos ativos, ator com leitura clínica → missing [DIAGNOSIS]', () => {
    const r = patientDetailCompleteness({ ...base, status: 'ADMISSION', activeDiagnosisCount: 0 }, LE);
    expect(r.missing).toEqual(['DIAGNOSIS']);
    expect(r.ready).toBe(false);
  });

  it('ADMISSION com 0 diagnósticos, ator SEM leitura clínica → CLINICAL_DATA (a trava existe; o nome clínico não vaza)', () => {
    const r = patientDetailCompleteness({ ...base, status: 'ADMISSION', activeDiagnosisCount: 0 }, NAO_LE);
    expect(r.missing).toEqual(['CLINICAL_DATA']);
    expect(r.ready).toBe(false);
    expect(JSON.stringify(r)).not.toContain('DIAGNOSIS');
  });

  it('ADMISSION COM diagnóstico ativo → nada falta, para quem lê e para quem não lê (sem pendência fantasma)', () => {
    expect(patientDetailCompleteness({ ...base, status: 'ADMISSION', activeDiagnosisCount: 2 }, LE).missing).toEqual([]);
    expect(patientDetailCompleteness({ ...base, status: 'ADMISSION', activeDiagnosisCount: 2 }, NAO_LE).missing).toEqual([]);
  });

  it.each(['PENDING_ADMISSION', 'SOLICITANTE', 'ACTIVE', 'SEARCHING', 'DISCHARGED'])(
    'paciente em %s (fora de ADMISSION) sem diagnóstico → não é afetado',
    (status) => {
      expect(patientDetailCompleteness({ ...base, status, activeDiagnosisCount: 0 }, LE).missing).toEqual([]);
    },
  );

  it('contagem AUSENTE no detalhe conta como 0 → em ADMISSION acusa (lado seguro, nunca "tem")', () => {
    expect(patientDetailCompleteness({ ...base, status: 'ADMISSION' }, LE).missing).toEqual(['DIAGNOSIS']);
  });
});
