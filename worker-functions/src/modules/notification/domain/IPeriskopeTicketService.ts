/**
 * IPeriskopeTicketService — porta para criação de tickets no Periskope.
 *
 * Separado de IMessagingService de propósito (parecer do Architect): ticket é
 * um conceito de gestão de fila/atribuição humana no Periskope, não de envio
 * de mensagem. Misturar os dois faria PeriskopeMessagingService (que
 * implementa a interface compartilhada com Twilio) crescer com um método sem
 * equivalente no outro provider.
 */
/**
 * Prioridade aceita pela API do Periskope (`1`..`4`, crescente).
 * String porque é assim que a API documenta e recebe o campo.
 */
export type TicketPriority = '1' | '2' | '3' | '4';

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
   * @param opts.labels ⚠️ NÃO USAR sem ler isto. A doc do fornecedor diz, sobre
   *   este campo: *"A comma-separated list of labels to be assigned to the
   *   contacts (...) Note: This replaces all the current labels of the
   *   contact"*. Ou seja: **o campo é do CONTATO, não do ticket, e SUBSTITUI** —
   *   passar "X" aqui apaga toda label que a pessoa já tinha. Medido em
   *   02/09/2026: 2 dos 200 contatos lidos têm label (`CABA CENTRO`,
   *   `Modo Silencio`), então o estrago é pequeno mas real e silencioso. Para
   *   usar com segurança é preciso LER as labels atuais do contato e mandar a
   *   união — o `PeriskopeChatReadService` de hoje só lê grupos e não serve.
   * @param opts.priority Prioridade do ticket. A API aceita **"1" a "4"**, e a
   *   escala é crescente: `1 = Low · 2 = Medium · 3 = High · 4 = Urgent`. Sem
   *   este campo o ticket nasce com **0**, que é abaixo de tudo — foi o que
   *   aconteceu com os 22 handovers da Luz de 30 dias (medido: 22/22 em
   *   `priority 0`, enquanto os tickets do próprio Periskope usam 1, 2 e 3).
   * @returns true se o ticket foi criado com sucesso; false em qualquer falha.
   */
  createTicket(
    chatPhone: string,
    subject: string,
    opts?: { assignee?: string; labels?: string; priority?: TicketPriority },
  ): Promise<boolean>;
}
