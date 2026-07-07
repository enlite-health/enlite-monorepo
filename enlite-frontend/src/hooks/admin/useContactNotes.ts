import { useState, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { ContactNote, CreateContactNotePayload } from '@domain/entities/ContactNote';

interface UseContactNotesState {
  notes: ContactNote[];
  isLoading: boolean;
  isCreating: boolean;
  deletingId: string | null;
  error: string | null;
}

interface UseContactNotesReturn extends UseContactNotesState {
  fetchNotes: () => Promise<void>;
  createNote: (payload: CreateContactNotePayload) => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;
}

/**
 * Notas de contato ESCOPADAS À VAGA (vacancyId) — uma única thread por vaga,
 * a mesma em todos os cards/linhas independentemente do candidato.
 */
export function useContactNotes(vacancyId: string): UseContactNotesReturn {
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchNotes = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await AdminApiService.getContactNotes(vacancyId);
      setNotes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setIsLoading(false);
    }
  }, [vacancyId]);

  const createNote = useCallback(
    async (payload: CreateContactNotePayload) => {
      setIsCreating(true);
      setError(null);
      try {
        await AdminApiService.createContactNote(vacancyId, payload);
        await fetchNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create note');
      } finally {
        setIsCreating(false);
      }
    },
    [vacancyId, fetchNotes],
  );

  const deleteNote = useCallback(
    async (noteId: string) => {
      setDeletingId(noteId);
      setError(null);
      try {
        await AdminApiService.deleteContactNote(vacancyId, noteId);
        await fetchNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete note');
      } finally {
        setDeletingId(null);
      }
    },
    [vacancyId, fetchNotes],
  );

  return {
    notes,
    isLoading,
    isCreating,
    deletingId,
    error,
    fetchNotes,
    createNote,
    deleteNote,
  };
}
