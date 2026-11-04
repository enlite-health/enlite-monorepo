/** O que a cascata escolhe: obra social -> contrato (oferecido) + vigência do vínculo (`validTo` inclusivo, vazio = sem fim). */
export interface ContractCascadeValue {
  providerCode: string;
  contractId: string;
  validFrom: string;
  validTo: string;
}

export const EMPTY_CASCADE: ContractCascadeValue = { providerCode: '', contractId: '', validFrom: '', validTo: '' };

