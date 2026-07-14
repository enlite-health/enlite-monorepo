/**
 * normalizePrescreeningResponseType
 *
 * SSOT dos formatos de resposta aceitos por uma pergunta de pré-screening
 * enviada à Talentum.
 *
 * Regra de negócio (ticket 86ajfm80t): o áudio é o DEFAULT — a EnLite contratou
 * a Talentum justamente por essa função (candidatos gravam áudio no WhatsApp).
 * A recrutadora pode, deliberadamente, restringir uma pergunta a só-texto pela
 * UI de criação de vaga; essa escolha explícita é respeitada.
 *
 * Dois modos:
 *  - Padrão (fronteiras: salvar config, enviar à Talentum, sync inbound):
 *    RESPEITA a escolha (['text'] deliberado continua ['text']); só aplica o
 *    default ['text','audio'] quando a entrada é ausente/vazia/inválida.
 *  - `forceAudio: true` (fonte — geração por IA): GARANTE áudio. A IA (Gemini)
 *    às vezes gera ['text'] só para perguntas sensíveis; sem isso o pré-screening
 *    nasceria com áudio desativado na prévia sem a recrutadora perceber.
 *
 * Saída sempre em ordem canônica: ['text'] | ['audio'] | ['text','audio'].
 */

export type PrescreeningResponseFormat = 'text' | 'audio';

const CANONICAL_ORDER: PrescreeningResponseFormat[] = ['text', 'audio'];

export function normalizePrescreeningResponseType(
  raw: unknown,
  opts: { forceAudio?: boolean } = {},
): PrescreeningResponseFormat[] {
  const input = Array.isArray(raw) ? raw : [];
  const present = new Set<PrescreeningResponseFormat>(
    input.filter((v): v is PrescreeningResponseFormat =>
      CANONICAL_ORDER.includes(v as PrescreeningResponseFormat),
    ),
  );

  if (opts.forceAudio) {
    // Fonte (IA): áudio sempre habilitado; texto sempre disponível.
    present.add('audio');
    present.add('text');
  } else if (present.size === 0) {
    // Fronteiras: default seguro só quando nada válido veio.
    present.add('text');
    present.add('audio');
  }

  // Ordem canônica, sem mutar a entrada.
  return CANONICAL_ORDER.filter((f) => present.has(f));
}
