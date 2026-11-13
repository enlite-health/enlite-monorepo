/**
 * Casamento pergunta local × pergunta remota (Talentum) para o PATCH /prescreening in-place.
 *
 * O nosso banco NÃO guarda o `questionId` do Talentum (DELETE+INSERT a cada save), então o id é
 * recuperado a cada envio: (1) texto normalizado idêntico; (2) o que sobrou, por posição; (3) local
 * sem par vai SEM id (pergunta nova); remota sem par fica de fora (removida). Função PURA.
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
  const remotes = remote.filter((r) => r.questionId);
  const ids: Array<string | undefined> = local.map(() => undefined);
  const usedRemote = new Set<number>();

  // (1) texto normalizado idêntico
  local.forEach((l, i) => {
    const key = normalizeQuestionText(l.question);
    const j = remotes.findIndex((r, idx) => !usedRemote.has(idx) && normalizeQuestionText(r.question) === key);
    if (j >= 0) {
      ids[i] = remotes[j].questionId;
      usedRemote.add(j);
    }
  });

  // (2) sobras locais × sobras remotas, por posição
  const leftoverRemote = remotes.map((_, idx) => idx).filter((idx) => !usedRemote.has(idx));
  let next = 0;
  local.forEach((_, i) => {
    if (ids[i] === undefined && next < leftoverRemote.length) {
      ids[i] = remotes[leftoverRemote[next++]].questionId;
    }
  });

  // (3) local sem par → sem questionId (nova); remota sem par simplesmente não é enviada (removida)
  return local.map((l, i) => (ids[i] ? { ...l, questionId: ids[i] } : { ...l }));
}
