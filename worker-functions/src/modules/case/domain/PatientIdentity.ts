/**
 * PatientIdentity — campos de identificação do paciente.
 * Sem campos clínicos. Owner: case-service (futuro GKE+Istio).
 * Persisted in: PatientIdentityRepository (Postgres — always).
 *
 * Health insurance coverage lives in PatientHealthInsuranceRepository
 * (patient_health_insurance table, migration 184). Not part of core identity.
 */
export interface PatientIdentity {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  documentType: string | null;
  documentNumber: string | null;
  sex: string | null;
  phoneWhatsapp: string | null;
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  createdAt: Date;
  updatedAt: Date;
}
