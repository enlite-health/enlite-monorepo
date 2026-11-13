/**
 * Casamento pergunta local × pergunta remota (Talentum) para o PATCH /prescreening in-place.
 *
 * O nosso banco NÃO guarda o `questionId` do Talentum (DELETE+INSERT a cada save), então o id é
 * recuperado a cada envio. O Talentum REAL (medido 13/11): sem questionId = pergunta nova com id novo;
 * omitida = removida; questionId enviado mantém a identidade (e as respostas dos candidatos). Por isso um
 * id NUNCA pode ir para uma pergunta que não seja a mesma.
 *  (1) texto normalizado idêntico herda o questionId;
 *  (2) fallback por ÍNDICE: a local na posição i só casa com a remota na MESMA posição i da lista remota,
 *      e só se essa remota ainda não foi casada. Sem par no mesmo índice → pergunta nova (sem questionId);
 *  (3) remota sem par simplesmente não é enviada (removida).
 * Ex.: remotas [A,B,C], locais [A',C,D] → A'↔A (índice 0), C↔C (texto), D nova, B removida.
 * Caso ambíguo que RESTA: remover X e, ao mesmo tempo, editar o texto da pergunta que assume o índice de X
 * herda o questionId de X (parece uma edição de X). Sem id local persistido não há como distinguir.
 * Função PURA.
 */
import type { TalentumQuestion } from './ITalentumApiClient';

export interface RemoteQuestionRef {
  questionId: string;
  question: string;
}

export type MatchedQuestion = TalentumQuestion & { questionId?: string };

/** trim + colapsa espaços + minúsculas. */
export function normalizeQuestionText(text: string | null | undefined): string {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function matchQuestionIds(
  local: readonly TalentumQuestion[],
  remote: readonly RemoteQuestionRef[],
): MatchedQuestion[] {
  const ids: Array<string | undefined> = local.map(() => undefined);
  const usedRemote = new Set<number>();

  // (1) texto normalizado idêntico
  local.forEach((l, i) => {
    const key = normalizeQuestionText(l.question);
    const j = remote.findIndex((r, idx) => !usedRemote.has(idx) && !!r.questionId && normalizeQuestionText(r.question) === key);
    if (j >= 0) {
      ids[i] = remote[j].questionId;
      usedRemote.add(j);
    }
  });

  // (2) mesma posição da lista, remota ainda livre
  local.forEach((_, i) => {
    if (ids[i] === undefined && i < remote.length && remote[i].questionId && !usedRemote.has(i)) {
      ids[i] = remote[i].questionId;
      usedRemote.add(i);
    }
  });

  // (3) local sem par → sem questionId (nova); remota sem par simplesmente não é enviada (removida)
  return local.map((l, i) => (ids[i] ? { ...l, questionId: ids[i] } : { ...l }));
}
