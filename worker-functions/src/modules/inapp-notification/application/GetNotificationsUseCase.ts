/**
 * GetNotificationsUseCase — `GET /api/admin/notifications` (Spec 022, Bloco 4, T406).
 *
 * `patientDisplayName`: resolvido SOB A CÉLULA DO DESTINATÁRIO da notificação (quem faz a
 * requisição) — revisão de D-13 no gate fecho B5 (21/09). A versão original resolvia pela célula
 * do ATOR do evento; achado do gate: quem posta sempre tem a célula, então o nome do paciente
 * vazava para QUALQUER destinatário mencionado, mesmo sem célula nenhuma — o efeito de
 * privacidade era o inverso do fallback "um paciente" pretendido. Sem célula de leitura do
 * paciente, `patientDisplayName = null`. Cache de UMA checagem por chamada (`recipientUid` é
 * sempre o mesmo dentro de uma resposta — não é mais por ator), sem cache entre requests
 * (decisão em tempo real).
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

    let recipientAllowed: boolean | undefined;
    const results: NotificationDto[] = [];

    for (const row of rows) {
      let patientDisplayName: string | null = null;

      if (row.patientId && this.accessChecker) {
        if (recipientAllowed === undefined) {
          recipientAllowed = await this.accessChecker.canReadPatientConversation(params.recipientUid);
        }
        if (recipientAllowed) {
          patientDisplayName = await this.repository.findPatientDisplayName(row.patientId);
        }
      }

      results.push({ ...row, patientDisplayName });
    }

    return results;
  }
}
