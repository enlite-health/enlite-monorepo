import { ContactNote, ContactNoteOwnership } from './ContactNote';

/**
 * Janela em que o autor pode excluir a própria nota: 2 horas após a criação.
 * Passado esse prazo, a nota vira permanente (não pode mais ser apagada).
 * Fonte única usada pelo guard de exclusão E pelo cálculo de `canDelete`
 * exposto na listagem (paridade exata servidor ↔ UI).
 */
export const CONTACT_NOTE_DELETE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * True se `requesterAdminId` pode excluir a nota agora: precisa ser o autor
 * E estar dentro da janela de 2h.
 */
export function canDeleteContactNote(
  note: ContactNote | ContactNoteOwnership,
  requesterAdminId: string,
  nowMs: number,
): boolean {
  if (note.createdByAdminId !== requesterAdminId) return false;
  const ageMs = nowMs - new Date(note.createdAt).getTime();
  return ageMs < CONTACT_NOTE_DELETE_WINDOW_MS;
}

/** ContactNote enriquecida com a permissão de exclusão pro operador atual. */
export interface ContactNoteView extends ContactNote {
  canDelete: boolean;
}
