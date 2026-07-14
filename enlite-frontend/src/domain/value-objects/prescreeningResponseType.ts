/**
 * prescreeningResponseType — regra de negócio de formatos de resposta aceitos
 * por uma pergunta de pré-screening (ticket 86ajfm80t).
 *
 * O áudio é o DEFAULT: a EnLite contratou a Talentum justamente para que os
 * candidatos possam responder gravando áudio no WhatsApp. A IA (Gemini) às
 * vezes gera `responseType: ['text']` só, deixando o checkbox de áudio
 * desmarcado sem a recrutadora perceber.
 *
 * - `ensureAudioDefault`: usado ao SEMEAR perguntas geradas por IA (criação de
 *   vaga) — garante áudio marcado por default. A recrutadora ainda pode
 *   desmarcar áudio depois (switch para só-texto), e essa escolha é respeitada.
 * - `safeResponseType`: guard defensivo de leitura (nunca `undefined.includes`).
 *
 * Espelha o normalizador do backend (worker-functions
 * `src/shared/utils/normalizePrescreeningResponseType.ts`).
 */

export type PrescreeningResponseFormat = 'text' | 'audio';

const CANONICAL_ORDER: PrescreeningResponseFormat[] = ['text', 'audio'];

/** Sanitiza para o domínio válido, em ordem canônica, sem mutar a entrada. */
export function safeResponseType(raw: unknown): PrescreeningResponseFormat[] {
  const input = Array.isArray(raw) ? raw : [];
  const present = new Set(
    input.filter((v): v is PrescreeningResponseFormat =>
      CANONICAL_ORDER.includes(v as PrescreeningResponseFormat),
    ),
  );
  const result = CANONICAL_ORDER.filter((f) => present.has(f));
  // Nunca deixa vazio (uma pergunta precisa aceitar ao menos um formato).
  return result.length > 0 ? result : ['text', 'audio'];
}

/** Garante que o áudio esteja marcado por default (fonte: geração por IA). */
export function ensureAudioDefault(raw: unknown): PrescreeningResponseFormat[] {
  const present = new Set(safeResponseType(raw));
  present.add('audio');
  present.add('text');
  return CANONICAL_ORDER.filter((f) => present.has(f));
}

/** Aplica `ensureAudioDefault` ao `responseType` de cada pergunta semeada. */
export function withAudioDefault<T extends { responseType?: unknown }>(
  questions: T[],
): Array<T & { responseType: PrescreeningResponseFormat[] }> {
  return questions.map((q) => ({ ...q, responseType: ensureAudioDefault(q.responseType) }));
}
