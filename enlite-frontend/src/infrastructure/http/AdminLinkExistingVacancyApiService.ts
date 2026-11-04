/**
 * AdminLinkExistingVacancyApiService — vínculo de vaga existente ao serviço contratado (spec 079).
 * Arquivo próprio: `AdminContractedServicesApiService.ts` está no teto de 400 linhas. O `fetch`, o
 * token e o `ContractedServiceApiError` (`err.code` em 409/422; `vacancyId`/`reason`/`blockers`
 * lidos do TOPO do corpo) são os do serviço irmão — nada reimplementado aqui.
 */
import { AdminContractedServicesApiService } from './AdminContractedServicesApiService';
import type { LinkConfirmResponse, LinkPreviewResponse } from '@domain/entities/LinkExistingVacancy';

const basePath = (patientId: string, serviceId: string): string =>
  `/api/admin/patients/${patientId}/contracted-services/${serviceId}/link-existing-vacancy`;

export const AdminLinkExistingVacancyApiService = {
  /**
   * POST .../link-existing-vacancy/preview — sem `vacancyId` lista as candidatas; com ele devolve também a
   * prévia daquela vaga. 409 `SERVICE_ALREADY_RECRUITING`/`VACANCY_NOT_LINKABLE` e 422
   * `LINK_BLOCKED`/`ADDRESS_NOT_OF_PATIENT` viram `ContractedServiceApiError` (`err.code`).
   */
  preview(patientId: string, serviceId: string, vacancyId?: string): Promise<LinkPreviewResponse> {
    return AdminContractedServicesApiService.request<LinkPreviewResponse>(
      'POST',
      `${basePath(patientId, serviceId)}/preview`,
      vacancyId ? { vacancyId } : {},
    );
  },

  /** POST .../link-existing-vacancy — confirma o vínculo; mesmos erros da prévia. */
  link(patientId: string, serviceId: string, vacancyId: string): Promise<LinkConfirmResponse> {
    return AdminContractedServicesApiService.request<LinkConfirmResponse>('POST', basePath(patientId, serviceId), { vacancyId });
  },
};
