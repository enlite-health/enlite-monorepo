/**
 * AdminSubstitutionRequestsApiService — as 6 rotas do pedido de substituição (spec 069, §3.3).
 * Arquivo próprio: `AdminContractedServicesApiService.ts` já tem 389 linhas (teto 400). O `fetch`, o
 * token e o `ContractedServiceApiError` (`err.code` em 409/422) são os do serviço irmão — nada
 * reimplementado aqui.
 */
import { AdminContractedServicesApiService } from './AdminContractedServicesApiService';
import type {
  CoverSubstitutionResult,
  CreateSubstitutionBody,
  CreateSubstitutionResult,
  OutgoingCandidate,
  SubstitutionPreview,
  SubstitutionPreviewBody,
  SubstitutionRequestsResult,
  SubstitutionWhen,
  UndoSubstitutionResult,
} from '@domain/entities/SubstitutionRequest';

const basePath = (patientId: string, serviceId: string): string =>
  `/api/admin/patients/${patientId}/contracted-services/${serviceId}/substitution-requests`;

export const AdminSubstitutionRequestsApiService = {
  /** GET .../substitution-requests?when=upcoming|past — uma linha por pedido, tudo derivado no servidor. */
  list(patientId: string, serviceId: string, when: SubstitutionWhen): Promise<SubstitutionRequestsResult> {
    return AdminContractedServicesApiService.request<SubstitutionRequestsResult>('GET', `${basePath(patientId, serviceId)}?when=${when}`);
  },

  /** GET .../substitution-requests/outgoing-options — "¿Quién no va a venir?", uma linha por pessoa. */
  async outgoingOptions(patientId: string, serviceId: string): Promise<OutgoingCandidate[]> {
    const { workers } = await AdminContractedServicesApiService.request<{ workers: OutgoingCandidate[] }>(
      'GET',
      `${basePath(patientId, serviceId)}/outgoing-options`,
    );
    return workers;
  },

  /** POST .../substitution-requests/preview — LEITURA: turnos, conflito tri-estado por candidato × turno, estado novo. */
  preview(patientId: string, serviceId: string, body: SubstitutionPreviewBody): Promise<SubstitutionPreview> {
    return AdminContractedServicesApiService.request<SubstitutionPreview>('POST', `${basePath(patientId, serviceId)}/preview`, body);
  },

  /** POST .../substitution-requests — UMA transação; 409/422 viram `ContractedServiceApiError` (`err.code`). */
  create(patientId: string, serviceId: string, body: CreateSubstitutionBody): Promise<CreateSubstitutionResult> {
    return AdminContractedServicesApiService.request<CreateSubstitutionResult>('POST', basePath(patientId, serviceId), body);
  },

  /** POST .../substitution-requests/:rid/undo — "Deshacer" o pedido INTEIRO. */
  undo(patientId: string, serviceId: string, requestId: string): Promise<UndoSubstitutionResult> {
    return AdminContractedServicesApiService.request<UndoSubstitutionResult>('POST', `${basePath(patientId, serviceId)}/${requestId}/undo`);
  },

  /** POST .../substitution-requests/:rid/cover — "Elegir quién entra" para os turnos que seguem sem ninguém. */
  cover(patientId: string, serviceId: string, requestId: string, substituteWorkerId: string): Promise<CoverSubstitutionResult> {
    return AdminContractedServicesApiService.request<CoverSubstitutionResult>('POST', `${basePath(patientId, serviceId)}/${requestId}/cover`, { substituteWorkerId });
  },
};
