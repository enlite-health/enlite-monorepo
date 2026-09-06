/**
 * PatientClinical — campos clínicos do paciente.
 * Owner: case-service (futuro GKE+Istio).
 * Persisted in: PatientClinicalRepository (Postgres TODAY, Healthcare API month 9).
 */
export interface PatientClinical {
  patientId: string;
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSegments: string | null;
  serviceType: string | null;
  deviceType: string | null;
  additionalComments: string | null;
  /** Instruções de emergência (REQ-01 · D211.2): texto clínico livre, sem cifra por decisão humana. */
  emergencyInstructions: string | null;
  hasJudicialProtection: boolean | null;
  hasCud: boolean | null;
  hasConsent: boolean | null;
}
