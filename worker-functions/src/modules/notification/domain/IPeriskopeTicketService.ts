/**
 * IPeriskopeTicketService — porta para criação de tickets no Periskope.
 *
 * Separado de IMessagingService de propósito (parecer do Architect): ticket é
 * um conceito de gestão de fila/atribuição humana no Periskope, não de envio
 * de mensagem. Misturar os dois faria PeriskopeMessagingService (que
 * implementa a interface compartilhada com Twilio) crescer com um método sem
 * equivalente no outro provider.
 */
export interface IPeriskopeTicketService {
  /**
   * Cria um ticket no Periskope para o chat 1-1 do worker.
   * Contrato best-effort: implementações NÃO devem lançar — falha é logada
   * internamente e o método retorna `false`. Callers não precisam de try/catch.
   *
   * @param chatPhone Telefone do worker em E.164 (será convertido para o
   *   formato de chat_id do Periskope internamente).
   * @param subject Assunto do ticket (ex: contexto do caso/handover).
   * @param opts.assignee Responsável pelo ticket. TODO: preencher com o nome
   *   da recrutadora quando o round-robin de atribuição for definido pelo
   *   produto — hoje sempre ausente.
   * @param opts.labels Labels do ticket (CSV, conforme API do Periskope).
   * @returns true se o ticket foi criado com sucesso; false em qualquer falha.
   */
  createTicket(
    chatPhone: string,
    subject: string,
    opts?: { assignee?: string; labels?: string },
  ): Promise<boolean>;
}
