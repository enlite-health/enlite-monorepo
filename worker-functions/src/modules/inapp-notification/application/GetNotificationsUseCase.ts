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
  /** Item 3 (deep-link, F10/F11): UNGATED, igual ao `messageId` — nunca depende da célula de
   *  leitura do paciente (a UI decide "sem acesso" separadamente). `null` quando a mensagem de
   *  origem É o root, ou quando não há `messageId` no evento. */
  rootMessageId: string | null;
  /** Item 2 (card com trecho, F7/F8): MESMO gate de `patientDisplayName` — só resolvido quando o
   *  destinatário tem `patient_conversation:read` para o paciente da conversa. `null` sem célula,
   *  sem `messageId`, ou se a decifra falhar. */
  messageExcerpt: string | null;
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

    // rootMessageId (item 3) é UNGATED — resolvido para TODO messageId presente, antes de
    // qualquer checagem de célula (o alvo do deep-link não depende da permissão de leitura).
    const allMessageIds = dedupNonNull(rows.map((row) => row.messageId));
    const rootMessageIds = await this.repository.findRootMessageIds(allMessageIds);

    // recipientAllowed (D-13/F7): UMA checagem por chamada, é sempre o mesmo destinatário —
    // mesmo cache já existente, agora também usado para gatear o trecho (item 2).
    let recipientAllowed: boolean | undefined;
    for (const row of rows) {
      if (row.patientId && this.accessChecker) {
        if (recipientAllowed === undefined) {
          recipientAllowed = await this.accessChecker.canReadPatientConversation(params.recipientUid);
        }
        break;
      }
    }

    // messageExcerpt (item 2) É gated: só para linhas com patientId E recipientAllowed — MESMO
    // conjunto que teria patientDisplayName resolvido, decifrado em LOTE (F8).
    const eligibleMessageIds = recipientAllowed
      ? dedupNonNull(rows.filter((row) => row.patientId).map((row) => row.messageId))
      : [];
    const excerpts = await this.repository.findMessageExcerpts(eligibleMessageIds);

    const results: NotificationDto[] = [];
    for (const row of rows) {
      let patientDisplayName: string | null = null;
      let messageExcerpt: string | null = null;

      if (row.patientId && this.accessChecker && recipientAllowed) {
        patientDisplayName = await this.repository.findPatientDisplayName(row.patientId);
        if (row.messageId) messageExcerpt = excerpts.get(row.messageId) ?? null;
      }

      const rootMessageId = row.messageId ? rootMessageIds.get(row.messageId) ?? null : null;

      results.push({ ...row, patientDisplayName, rootMessageId, messageExcerpt });
    }

    return results;
  }
}

/** uids/ids não-nulos, sem repetição, na ordem de 1ª aparição — evita decifrar/ler o MESMO
 *  messageId duas vezes quando várias notificações apontam pra mesma mensagem (custo de KMS). */
function dedupNonNull(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}
