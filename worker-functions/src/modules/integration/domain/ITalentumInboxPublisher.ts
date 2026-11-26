/**
 * ITalentumInboxPublisher — port de publicação do aviso "chegou linha na inbox" (spec 095 §3.2).
 *
 * Publica SÓ o id da linha: o payload tem PII e fica na inbox cifrado, nunca na mensagem do Pub/Sub.
 */
export interface ITalentumInboxPublisher {
  publish(inboxId: string): Promise<void>;
}
