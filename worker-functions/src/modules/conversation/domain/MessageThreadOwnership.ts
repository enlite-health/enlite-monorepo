/**
 * MessageThreadOwnership — guarda ÚNICO de "esta mensagem pertence a ESTA conversa?"
 * (spec 022, Bloco 1; achado do gate revisao-pr, fecho da classe).
 *
 * Duas rotas cruzam id de mensagem × conversationId da rota, por vetores DIFERENTES:
 *  - `AdminConversationController.assertMessageBelongsToPatientConversation` — `:mid` vem de
 *    ROUTE PARAM (editMessage/deleteMessage/listReplies).
 *  - `PostMessageUseCase.resolveRoot` — `rootMessageId` vem do BODY do POST (achado NOVO,
 *    `specs/022-chat-interno-por-paciente/evidencias/achados.md`: sem este guard, uma reply
 *    podia gravar `root_message_id` apontando para mensagem de OUTRO paciente — o corpo cifrado
 *    dessa mensagem alheia então aparecia no GET replies do paciente dono do root).
 *
 * A MESMA condição (`info?.conversationId === conversationId`) estava implementada 1x no
 * controller; extraída aqui para o use case reusar em vez de duplicar — duas cópias da mesma
 * regra divergem com o tempo (memória `consertar-a-instancia-nao-conserta-a-classe`).
 */
export function messageBelongsToConversation(
  info: { conversationId: string } | null,
  conversationId: string,
): boolean {
  return info?.conversationId === conversationId;
}
