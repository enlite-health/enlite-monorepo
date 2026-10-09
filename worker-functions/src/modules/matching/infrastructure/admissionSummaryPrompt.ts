/**
 * Instruções do resumo de admissão (D482: o "Gem" da Enlite vive no nosso código, versionado).
 *
 * TODO(H4): as instruções do Gem atual NÃO vieram (dependência humana H4 da spec 049, §7). Este texto é PROVISÓRIO e propositalmente
 * NEUTRO: não define estrutura, seções nem roteiro de entrevista — isso é decisão da Enlite. Quando H4 chegar, troque o
 * texto e suba `ADMISSION_SUMMARY_PROMPT_VERSION` (o número vai na trilha, em `summary_saved`).
 */
export const ADMISSION_SUMMARY_PROMPT_VERSION = 'v0-provisorio-TODO-H4';

export const ADMISSION_SUMMARY_SYSTEM_INSTRUCTION = [
  'Eres un asistente de la Enlite. Recibís la transcripción de una reunión de admisión y devolvés un resumen fiel.',
  'Reglas: usá solo lo que está en la transcripción; no inventes ni completes datos; si algo no quedó claro, decilo.',
  'Texto plano en español, sin markdown. No repitas la transcripción.',
  // TODO(H4): sustituir por las instrucciones oficiales del Gem de la Enlite (estructura y secciones del resumen).
].join('\n');
