/**
 * Detecção de intenção de opt-out ("no quiero más mensajes") em texto livre inbound.
 *
 * Fecha o gap do incidente 2026-07-10: antes o InboundWhatsAppController fazia
 * match EXATO do Body inteiro contra um set curto — "quiero darme de baja" (frase)
 * NÃO casava, e faltavam termos es-AR comuns (baja, salir, no me escriban…).
 *
 * Dois níveis, ambos sobre o texto NORMALIZADO (minúsculo, sem acento, espaços
 * colapsados) — pra "más"/"mas", "número"/"numero" e afins baterem igual:
 *
 *   - EXACT   : o body inteiro É um termo de baixa. Cobre termos que seriam
 *               perigosos como substring — "no quiero" casa se o body é só isso,
 *               mas "no quiero perder la vacante" NÃO casa.
 *   - CONTAINS: frases INEQUÍVOCAS que, aparecendo em qualquer lugar do texto,
 *               são baixa ("darme de baja", "no me escriban"). Seguras como
 *               substring porque não ocorrem em contexto positivo.
 *
 * Conservador por design: na dúvida, NÃO marca opt-out (falso-negativo é
 * recuperável — a pessoa repete; falso-positivo cala um lead que queria falar).
 */

/** Payload do botão quick-reply de opt-out (quando o template ganhar o botão no Meta). */
export const OPT_OUT_BUTTON_PAYLOAD = 'optout';

const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeForOptOut(text: string): string {
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '') // remove acentos (marcas combinantes)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Body inteiro === um destes (já normalizado, sem acento).
const OPT_OUT_EXACT = new Set<string>([
  // originais
  'parar', 'stop', 'cancelar', 'desuscribir', 'desuscribirme',
  'no quiero', 'basta', 'unsubscribe', 'optout', 'opt-out', 'opt out',
  // es-AR / pt comuns (palavra/short whole-body)
  'baja', 'salir', 'salgo', 'sacame', 'sacar', 'eliminar', 'borrar',
  'no molestar', 'no enviar', 'no escriban', 'no recibir', 'chau',
]);

// Substring inequívoca (já normalizada). NÃO incluir termos ambíguos (ex: "no").
const OPT_OUT_CONTAINS: string[] = [
  'darme de baja', 'dar de baja', 'darse de baja', 'me doy de baja',
  'no me escriban', 'no me escribas', 'no me manden', 'no me envien',
  'no me contacten', 'dejen de escribir', 'dejen de enviar', 'deja de escribir',
  'no molestar', 'sacame de la lista', 'sacar de la lista',
  'eliminar mi numero', 'borrar mi numero', 'borra mi numero',
  'mi numero de la lista', // "borren/saquen/eliminen mi numero de la lista" — verbo-agnóstico
  'no quiero recibir', 'no quiero mas mensaje', 'no deseo recibir',
  'ya no quiero', 'no recibir mas',
];

/** true se o texto inbound expressa intenção de não receber mais mensagens. */
export function matchesOptOut(rawBody: string): boolean {
  const t = normalizeForOptOut(rawBody);
  if (!t) return false;
  if (OPT_OUT_EXACT.has(t)) return true;
  return OPT_OUT_CONTAINS.some(phrase => t.includes(phrase));
}
