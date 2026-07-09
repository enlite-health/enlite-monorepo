/**
 * periskopeAckMapping — item 2.3 (delivery tracking) da migração Periskope.
 *
 * Mapeia o `ack` numérico do evento webhook `message.ack.updated` do
 * Periskope para o MESMO vocabulário de `delivery_status` já gravado pelo
 * canal Twilio (grep confirma os valores lidos pelos consumidores
 * existentes — GetFunnelTableUseCase.deriveWhatsAppStatus,
 * RecruitmentHealthController — usam 'sent' | 'delivered' | 'read' |
 * 'failed' | 'undelivered'). NUNCA inventar valor novo aqui.
 *
 * Semântica oficial do Periskope
 * (https://docs.periskope.app/api-reference/delivery-status.md):
 *   -1 = failed
 *    0 = pending send (fila local, ainda não saiu)
 *    1 = sent to WhatsApp servers (aguardando confirmação)
 *    2 = delivered to WhatsApp servers (NÃO ao destinatário!)
 *    3 = delivered to all recipients (aparelho do destinatário)
 *    4/5 = read/played by all (tick azul)
 * ATENÇÃO: difere da convenção whatsapp-web.js (onde 2=device, 3=read).
 * No vocabulário Twilio: 'delivered' = chegou no aparelho ⇒ só ack 3.
 *
 * Acks são monotônicos (só crescem). 0 e valores desconhecidos retornam
 * null (== "ignora, não atualiza") para nunca sobrescrever um
 * delivery_status já mais avançado com um dado ambíguo.
 */
const ACK_TO_DELIVERY_STATUS: Record<number, string> = {
  [-1]: 'failed',
  1: 'sent',
  2: 'sent',
  3: 'delivered',
  4: 'read',
  5: 'read',
};

export function mapPeriskopeAckToDeliveryStatus(ack: number): string | null {
  return ACK_TO_DELIVERY_STATUS[ack] ?? null;
}
