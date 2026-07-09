import { TemplateButton } from './MessageTemplate';

/**
 * numberedButtonOptions — SSOT para renderização/parse de botões quick-reply
 * como opções numeradas (item 2.3 da migração Twilio → Periskope).
 *
 * O canal Periskope (WhatsApp Web) não tem botões interativos: o outbound
 * (PeriskopeMessagingService.renderMessage) renderiza os botões do template
 * como lista numerada no fim do texto, e o worker responde digitando o
 * número. O inbound (PeriskopeInboundRouter) precisa interpretar essa MESMA
 * numeração para rotear a resposta ao use case certo.
 *
 * Os dois lados DEVEM usar este módulo — nunca renderizar/parsear a
 * numeração inline. Divergência (ex: outbound mudar o footer/ordem sem o
 * inbound acompanhar) quebraria o roteamento silenciosamente.
 */

/** Renderiza o bloco de opções numeradas (sem o corpo da mensagem). */
export function renderNumberedOptions(buttons: TemplateButton[]): string {
  const options = buttons
    .map((b: TemplateButton, i: number) => `*${i + 1}.* ${b.label}`)
    .join('\n');
  return `${options}\n\n_Respondé con el número de la opción._`;
}

/**
 * Interpreta uma resposta de texto livre como escolha numerada.
 * Tolera espaços e ponto final ("1", " 1 ", "1."). Fora do range (incluindo
 * 0, negativos ou maior que a quantidade de botões) → null. Texto
 * não-numérico → null — o caller deve seguir o fluxo atual
 * (awaiting_reason / ignorar).
 */
export function parseNumberedReply(
  text: string,
  buttons: TemplateButton[],
): TemplateButton | null {
  const match = /^\s*(\d+)\s*\.?\s*$/.exec(text);
  if (!match) return null;

  const index = parseInt(match[1], 10);
  if (index < 1 || index > buttons.length) return null;

  return buttons[index - 1];
}
