/**
 * GetNotificationsUseCase — `GET /api/admin/notifications` (Spec 022, Bloco 4, T406).
 *
 * `patientDisplayName` (D-13): resolvido SOB A CÉLULA DO ATOR do evento — nunca do destinatário
 * (quem está pedindo a lista pode não ter célula nenhuma de paciente e ainda assim ver "Fulano
 * mencionou você em Ciclano", contanto que FULANO, o ator, ainda tenha a célula hoje). Cache por
 * `actorUid` DENTRO de uma chamada (`Map`) — evita 1 checagem de permissão por notificação
 * quando várias vêm do MESMO ator (thread ativa), sem cache entre requests (decisão em tempo
 * real, nunca памятная).
 */
import { NotificationRepository, type NotificationTypeCode } from '../infrastructure/NotificationRepository';
import type { ActorPatientConversationAccessChecker } from './ports';

export interface GetNotificationsParams {
  recipientUid: string;
  unreadOnly?: boolean;
  limit: number;
}

export interface NotificationDto {
  id: string;
  typeCode: NotificationTypeCode;
  actorUid: string;
  actorDisplayName: string | null;
  patientId: string | null;
  patientDisplayName: string | null;
  conversationId: string | null;
  messageId: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export class GetNotificationsUseCase {
  constructor(
    private readonly repository: NotificationRepository = new NotificationRepository(),
    private readonly accessChecker?: ActorPatientConversationAccessChecker,
  ) {}

  async execute(params: GetNotificationsParams): Promise<NotificationDto[]> {
    const rows = await this.repository.listForRecipient(params.recipientUid, {
      unreadOnly: params.unreadOnly,
      limit: params.limit,
    });

    const accessByActor = new Map<string, boolean>();
    const results: NotificationDto[] = [];

    for (const row of rows) {
      let patientDisplayName: string | null = null;

      if (row.patientId && this.accessChecker) {
        let allowed = accessByActor.get(row.actorUid);
        if (allowed === undefined) {
          allowed = await this.accessChecker.canReadPatientConversation(row.actorUid);
          accessByActor.set(row.actorUid, allowed);
        }
        if (allowed) {
          patientDisplayName = await this.repository.findPatientDisplayName(row.patientId);
        }
      }

      results.push({ ...row, patientDisplayName });
    }

    return results;
  }
}
