/**
 * stageMessagePreview — as regras de TEXTO da mensagem por etapa, fora do
 * componente (o lint do projeto proíbe exportar não-componente de arquivo .tsx).
 *
 * Uma regra só, usada em dois lugares: a linha da tabela e a prévia da modal
 * mostram exatamente o mesmo texto, com os mesmos valores de exemplo.
 */
import type { FunnelStageTemplateOption } from '@infrastructure/http/AdminFunnelStageMessagesApiService';

/**
 * Acima disto a lista deixa de caber de um olhar e aparece a busca. O teto real
 * hoje é 8 (17 UTILITY aprovados na Twilio, menos 9 da deny-list), então em
 * produção o campo não aparece — ele existe para quando a Meta aprovar mais.
 */
export const SEARCH_THRESHOLD = 8;

/** Valores de exemplo da prévia. Fictícios por regra: nunca dado de worker real. */
const SAMPLE: Record<string, string> = {
  worker_name: 'María González',
  name: 'María González',
  case_number: 'CASO 1042',
};

/**
 * Corpos que as migrations gravaram como PONTEIRO para o Content Builder, não
 * como mensagem. Mostrá-los seria mentir sobre o que a cuidadora recebe.
 */
const POINTER_BODY = /^\s*[([](?:ver Twilio Content Builder|Template aprovado Twilio)\b/i;

/** `{{x}}` do corpo, sem duplicatas, na ordem de aparição — mesma regra do backend. */
export function placeholdersOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Texto a exibir, ou null quando não há texto de verdade.
 * `bodyTwilio` é posicional (`{{1}}`); os nomes vêm de `body`, na mesma ordem que
 * o TwilioMessagingService usa para montar as contentVariables.
 */
export function previewTextOf(tpl: Pick<FunnelStageTemplateOption, 'body' | 'bodyTwilio'>): string | null {
  const named = placeholdersOf(tpl.body ?? '');
  const raw = tpl.bodyTwilio ?? tpl.body ?? '';
  if (!raw.trim() || POINTER_BODY.test(raw)) return null;
  return raw.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_full, key: string) => {
    const pos = Number(key);
    const resolved = Number.isInteger(pos) && pos > 0 ? (named[pos - 1] ?? key) : key;
    return SAMPLE[resolved] ?? `«${resolved}»`;
  });
}

/** Uma linha só: o começo do texto, ou null quando não há texto. */
export function summaryOf(tpl: Pick<FunnelStageTemplateOption, 'body' | 'bodyTwilio'>): string | null {
  const text = previewTextOf(tpl);
  return text ? text.replace(/\s+/g, ' ').trim() : null;
}
