import { useState, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { ContactNote, CreateContactNotePayload } from '@domain/entities/ContactNote';

interface UseContactNotesState {
  notes: ContactNote[];
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
}

interface UseContactNotesReturn extends UseContactNotesState {
  fetchNotes: () => Promise<void>;
  createNote: (payload: CreateContactNotePayload) => Promise<void>;
}

export function useContactNotes(
  vacancyId: string,
  wjaId: string,
): UseContactNotesReturn {
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchNotes = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await AdminApiService.getContactNotes(vacancyId, wjaId);
      setNotes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setIsLoading(false);
    }
  }, [vacancyId, wjaId]);

  const createNote = useCallback(
    async (payload: CreateContactNotePayload) => {
      setIsCreating(true);
      setError(null);
      try {
        await AdminApiService.createContactNote(vacancyId, wjaId, payload);
        await fetchNotes();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create note');
      } finally {
        setIsCreating(false);
      }
    },
    [vacancyId, wjaId, fetchNotes],
  );

  return { notes, isLoading, isCreating, error, fetchNotes, createNote };
}
