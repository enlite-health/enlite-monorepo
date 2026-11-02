/**
 * Preço por MILHÃO de tokens (USD) para o custo ESTIMADO da IA (spec 082, DF-10 / RF-7). Padrão do `prices.ts` do assistants-service.
 * Gemini 2.5 Flash, texto, tier padrão: entrada 0.30 / saída 2.50 (a saída inclui os tokens de raciocínio).
 * Fontes (consultadas em 30/10/2026, pelo assistants-service):
 *  - https://docs.cloud.google.com/vertex-ai/generative-ai/pricing
 *  - https://ai.google.dev/gemini-api/docs/pricing
 * Modelo sem preço aqui → custo `null` (desconhecido); NUNCA zero nem chute. A tela marca a linha como "estimado".
 */
/** Moeda do custo estimado (a tabela de preços é em USD). */
export const AI_COST_CURRENCY = 'USD';

export const AI_PRICE_PER_MILLION: Readonly<Record<string, { input: number; output: number }>> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

export function estimateAiCostUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  if (!Object.prototype.hasOwnProperty.call(AI_PRICE_PER_MILLION, model)) return null;
  const p = AI_PRICE_PER_MILLION[model];
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}
