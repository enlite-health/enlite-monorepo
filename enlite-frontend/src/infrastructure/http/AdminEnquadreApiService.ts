/**
 * AdminEnquadreApiService — o evento de enquadre na vaga (spec 052). As 11 rotas de `adminEnquadreEventRoutes.ts`
 * (`worker-functions`, módulo matching). Auth, base URL, envelope `{success,data}` e `ApiError` são os do cliente da
 * Admissão (`requestJson`): erro de domínio chega como `ApiError` com `code` estável (ver `enquadreErrors.ts`).
 * Os testes e o harness trocam estes métodos estáticos; as assinaturas ficam. Nada aqui loga corpo nem dado pessoal.
 */
import type {
  CreateEnquadreEventInput,
  EnquadreAvailableWorkers,
  EnquadreColumnId,
  EnquadreEventDetail,
  EnquadreEventListItem,
  EnquadreHostOption,
} from '@domain/entities/EnquadreEvent';
import { AdminAdmissionApiService } from './AdminAdmissionApiService';

const base = (vacancyId: string): string => `/api/admin/vacancies/${encodeURIComponent(vacancyId)}/enquadre-events`;
const seg = encodeURIComponent;

export class AdminEnquadreApiService {
  static async listEvents(vacancyId: string): Promise<EnquadreEventListItem[]> {
    return AdminAdmissionApiService.requestJson<EnquadreEventListItem[]>('GET', base(vacancyId));
  }

  static async getEvent(vacancyId: string, eventId: string): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>('GET', `${base(vacancyId)}/${seg(eventId)}`);
  }

  static async listAvailableWorkers(vacancyId: string): Promise<EnquadreAvailableWorkers> {
    return AdminAdmissionApiService.requestJson<EnquadreAvailableWorkers>('GET', `${base(vacancyId)}/available-workers`);
  }

  static async listHosts(vacancyId: string): Promise<EnquadreHostOption[]> {
    return AdminAdmissionApiService.requestJson<EnquadreHostOption[]>('GET', `${base(vacancyId)}/hosts`);
  }

  /**
   * Horários de início livres na agenda do entrevistador no dia `date` (`YYYY-MM-DD`), em hora de parede `HH:mm`,
   * já calculados pelo servidor para a duração pedida. A tela não calcula disponibilidade.
   */
  static async listHostFreeSlots(vacancyId: string, hostId: string, date: string, durationMinutes: number): Promise<string[]> {
    const qs = `date=${seg(date)}&durationMinutes=${durationMinutes}`;
    return AdminAdmissionApiService.requestJson<string[]>('GET', `${base(vacancyId)}/hosts/${seg(hostId)}/free-slots?${qs}`);
  }

  static async createEvent(vacancyId: string, input: CreateEnquadreEventInput): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>('POST', base(vacancyId), input);
  }

  static async closeEvent(vacancyId: string, eventId: string): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>('POST', `${base(vacancyId)}/${seg(eventId)}/close`);
  }

  static async cancelEvent(vacancyId: string, eventId: string): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>('POST', `${base(vacancyId)}/${seg(eventId)}/cancel`);
  }

  static async addParticipants(vacancyId: string, eventId: string, workerIds: string[]): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>('POST', `${base(vacancyId)}/${seg(eventId)}/participants`, { workerIds });
  }

  static async removeParticipant(vacancyId: string, eventId: string, participantId: string): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>(
      'POST',
      `${base(vacancyId)}/${seg(eventId)}/participants/${seg(participantId)}/remove`,
    );
  }

  /**
   * `reason` = motivo obrigatório ao ENTRAR em Rejeitados (categoria de rejeição) e ao SAIR dele (spec §5.2). Como no
   * funil da vaga, quem decide que o motivo faltou é o servidor: 422 `MOVE_REASON_REQUIRED` (`ApiError`), e a tela reage.
   */
  static async moveParticipant(
    vacancyId: string,
    eventId: string,
    participantId: string,
    column: EnquadreColumnId,
    reason?: string,
  ): Promise<EnquadreEventDetail> {
    return AdminAdmissionApiService.requestJson<EnquadreEventDetail>(
      'PUT',
      `${base(vacancyId)}/${seg(eventId)}/participants/${seg(participantId)}/move`,
      reason === undefined ? { column } : { column, reason },
    );
  }
}
