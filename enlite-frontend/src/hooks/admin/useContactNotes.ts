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

export function useContactNotes(
  vacancyId: string,
  workerId: string,
): UseContactNotesReturn {
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchNotes = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await AdminApiService.getContactNotes(vacancyId, workerId);
      setNotes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setIsLoading(false);
    }
  }, [vacancyId, workerId]);

  const createNote = useCallback(
    async (payload: CreateContactNotePayload) => {
      setIsCreating(true);
      setError(null);
      try {
        await AdminApiService.createContactNote(vacancyId, workerId, payload);
        await fetchNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create note');
      } finally {
        setIsCreating(false);
      }
    },
    [vacancyId, workerId, fetchNotes],
  );

  const deleteNote = useCallback(
    async (noteId: string) => {
      setDeletingId(noteId);
      setError(null);
      try {
        await AdminApiService.deleteContactNote(vacancyId, workerId, noteId);
        await fetchNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete note');
      } finally {
        setDeletingId(null);
      }
    },
    [vacancyId, workerId, fetchNotes],
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
