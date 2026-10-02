/**
 * ListRepliesUseCase — lista as replies de uma thread de 1 nível (spec 022, Bloco 1, LACUNA 1 do
 * fecho do B1; contrato `GET .../messages/:mid/replies` em `contracts/openapi-conversation.md`).
 *
 * Regra do contrato: `:mid` PRECISA ser mensagem de TOPO (`root_message_id IS NULL`) — thread é
 * de 1 nível (D-03), então uma reply não tem replies próprias. Se `:mid` já é uma reply, recusa
 * com `RootMessageIsReplyError` (o controller converte em 400).
 *
 * `:mid` inexistente: `ConversationRepository.findMessageThreadInfo` devolve `null` — não há como
 * saber se É uma reply, então segue para `listReplies` (que devolve lista vazia por não achar
 * nenhuma linha com esse `root_message_id`). Honesto: array vazio real, não erro inventado que o
 * contrato não pede — mesmo padrão de fallback de `PostMessageUseCase.resolveRoot`.
 *
 * Delega a `ConversationRepository.listReplies` (T108, já 100% coberto) — este use case não monta
 * SQL nem decifra corpo, só aplica a validação de "é topo" acima da leitura.
 */
import { ConversationRepository, ReplyMessageRow } from '../infrastructure/ConversationRepository';

export interface ListRepliesParams {
  rootMessageId: string;
}

/** `:mid` é uma reply, não uma mensagem de topo — recusa (o controller converte em 400). */
export class RootMessageIsReplyError extends Error {
  readonly code = 'ROOT_MESSAGE_IS_REPLY';
  readonly status = 400;

  constructor(readonly messageId: string) {
    super(`message ${messageId} is a reply, not a top-level message — thread is 1 level (D-03)`);
    this.name = 'RootMessageIsReplyError';
  }
}

export class ListRepliesUseCase {
  constructor(private readonly repository: ConversationRepository = new ConversationRepository()) {}

  async execute(params: ListRepliesParams): Promise<ReplyMessageRow[]> {
    const { rootMessageId } = params;

    const info = await this.repository.findMessageThreadInfo(rootMessageId);
    if (info?.rootMessageId) {
      throw new RootMessageIsReplyError(rootMessageId);
    }

    return this.repository.listReplies(rootMessageId);
  }
}
