/**
 * AdminEnquadreApiService — assinaturas FINAIS do evento de enquadre (spec 052). Fase 0: nenhum corpo fala com
 * o servidor (o backend é da Fase 2); todos lançam. Os dados de mentira vivem em `src/preview/`, que só o harness
 * instala sobrescrevendo estes métodos. A Fase 2 troca os corpos e nada mais.
 */
import type {
  CreateEnquadreEventInput,
  EnquadreAvailableWorkers,
  EnquadreColumnId,
  EnquadreEventDetail,
  EnquadreEventListItem,
  EnquadreHostOption,
} from '@domain/entities/EnquadreEvent';

export class AdminEnquadreApiService {
  static async listEvents(_vacancyId: string): Promise<EnquadreEventListItem[]> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async getEvent(_vacancyId: string, _eventId: string): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async listAvailableWorkers(_vacancyId: string): Promise<EnquadreAvailableWorkers> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async listHosts(_vacancyId: string): Promise<EnquadreHostOption[]> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  /**
   * Horários de início livres na agenda do entrevistador no dia `date` (`YYYY-MM-DD`), em hora de parede `HH:mm`,
   * já calculados pelo servidor para a duração pedida. A tela não calcula disponibilidade.
   */
  static async listHostFreeSlots(_vacancyId: string, _hostId: string, _date: string, _durationMinutes: number): Promise<string[]> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async createEvent(_vacancyId: string, _input: CreateEnquadreEventInput): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async closeEvent(_vacancyId: string, _eventId: string): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async cancelEvent(_vacancyId: string, _eventId: string): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async addParticipants(_vacancyId: string, _eventId: string, _workerIds: string[]): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  static async removeParticipant(_vacancyId: string, _eventId: string, _participantId: string): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }

  /**
   * `reason` = motivo obrigatório ao ENTRAR em Rejeitados (categoria de rejeição) e ao SAIR dele (spec §5.2). Como no
   * funil da vaga, quem decide que o motivo faltou é o servidor: 422 `MOVE_REASON_REQUIRED` (`ApiError`), e a tela reage.
   */
  static async moveParticipant(
    _vacancyId: string,
    _eventId: string,
    _participantId: string,
    _column: EnquadreColumnId,
    _reason?: string,
  ): Promise<EnquadreEventDetail> {
    throw new Error('enquadre: backend só na Fase 2');
  }
}
