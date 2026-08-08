/**
 * PatientIdentity — campos de identificação do paciente.
 * Sem campos clínicos. Owner: case-service (futuro GKE+Istio).
 * Persisted in: PatientIdentityRepository (Postgres — always).
 */
export interface PatientIdentity {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  documentType: string | null;
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null;
  phoneWhatsapp: string | null;
  insuranceInformed: string | null;
  insuranceVerified: string | null;
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  /** chat_id do grupo de WhatsApp da FAMÍLIA no Periskope (@g.us). Migration 260. */
  familyChatId: string | null;
  /** chat_id do grupo de WhatsApp dos PRESTADORES no Periskope (@g.us). Migration 260. */
  providersChatId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
