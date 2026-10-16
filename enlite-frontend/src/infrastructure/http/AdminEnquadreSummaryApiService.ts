/**
 * AdminEnquadreSummaryApiService — o download do resumo (PDF) do evento de enquadre (spec 052, Fase 3). Uma rota, atrás da quinta
 * célula (`enquadre_summary:read`): `GET /api/admin/vacancies/:vacancyId/enquadre-events/:eventId/summary/url`, que devolve uma URL
 * assinada de 300 s. A URL é pedida a CADA clique e nunca guardada; o caminho do objeto nunca chega à tela. Sem a célula o servidor
 * responde 403 (e a tela nem mostra o botão). Mesmo cliente HTTP do `AdminEnquadreApiService` (auth, envelope, `ApiError`).
 */
import { AdminAdmissionApiService } from './AdminAdmissionApiService';

export interface EnquadreSummarySignedUrl {
  url: string;
  expiresInSeconds: number;
}

export class AdminEnquadreSummaryApiService {
  static async getSummaryUrl(vacancyId: string, eventId: string): Promise<EnquadreSummarySignedUrl> {
    return AdminAdmissionApiService.requestJson<EnquadreSummarySignedUrl>(
      'GET',
      `/api/admin/vacancies/${encodeURIComponent(vacancyId)}/enquadre-events/${encodeURIComponent(eventId)}/summary/url`,
    );
  }
}
