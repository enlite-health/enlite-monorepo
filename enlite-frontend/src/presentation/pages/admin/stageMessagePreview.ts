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
 * `{{x}}` do corpo, sem duplicatas, na ordem de aparição.
 *
 * ⚠️ CONTRATO: esta regex é a MESMA de `StageTemplateEligibility.extractPlaceholders`
 * no backend — `[A-Za-z0-9_]+`, não `[^}]+`. Elas precisam casar porque o envio
 * monta as contentVariables pela ordem que o BACKEND enxerga, e a prévia promete
 * mostrar essa mesma mensagem. Divergir faz a tela mentir sobre qual valor cai em
 * qual slot. O teste `stageMessagePreview.test.ts` trava os dois casos de borda.
 */
export function placeholdersOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Texto a exibir, ou null quando não há texto aprovado.
 *
 * REGRA DURA: a prévia mostra **só `bodyTwilio`** — o texto que a Meta aprovou.
 * Nunca `body`, e isso não é preciosismo: `body` é o contrato de ENVIO (a ordem
 * dos nomes), e uma conferência de 31/08 contra a Content API mostrou 12 dos 27
 * templates com `body` divergindo do texto aprovado — de ponteiro
 * (`(ver Twilio Content Builder: HX…)`) a cópia velha. Ler `body` aqui foi o que
 * já pôs um sentinela na tela como se fosse mensagem; enquanto a prévia depender
 * só do texto aprovado, sentinela NENHUM — inclusive os que ainda não existem —
 * tem por onde entrar, e não é preciso nenhum filtro reconhecendo literais.
 *
 * `bodyTwilio` é posicional (`{{1}}`); os nomes vêm de `body`, na mesma ordem que
 * o TwilioMessagingService usa para montar as contentVariables.
 */
export function previewTextOf(tpl: Pick<FunnelStageTemplateOption, 'body' | 'bodyTwilio'>): string | null {
  const named = placeholdersOf(tpl.body ?? '');
  const raw = tpl.bodyTwilio ?? '';
  if (!raw.trim()) return null;
  // Mesma classe de caractere do parser: o que não casa fica literal na tela
  // (honesto — melhor a pessoa ver `{{algo}}` do que a tela fingir que resolveu).
  return raw.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_full, key: string) => {
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
