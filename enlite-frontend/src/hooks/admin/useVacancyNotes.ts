import { useState, useCallback } from 'react';
import { AdminVacancyListApiService } from '@infrastructure/http/AdminVacancyListApiService';
import type { VacancyNote, CreateVacancyNotePayload } from '@domain/entities/VacancyNote';

interface UseVacancyNotesState {
  notes: VacancyNote[];
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
}

interface UseVacancyNotesReturn extends UseVacancyNotesState {
  fetchNotes: () => Promise<void>;
  createNote: (payload: CreateVacancyNotePayload) => Promise<void>;
}

export function useVacancyNotes(vacancyId: string): UseVacancyNotesReturn {
  const [notes, setNotes] = useState<VacancyNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchNotes = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await AdminVacancyListApiService.listVacancyNotes(vacancyId);
      setNotes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setIsLoading(false);
    }
  }, [vacancyId]);

  const createNote = useCallback(
    async (payload: CreateVacancyNotePayload) => {
      setIsCreating(true);
      setError(null);
      try {
        await AdminVacancyListApiService.createVacancyNote(vacancyId, payload);
        await fetchNotes();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create note';
        setError(message);
        throw err;
      } finally {
        setIsCreating(false);
      }
    },
    [vacancyId, fetchNotes],
  );

  return {
    notes,
    isLoading,
    isCreating,
    error,
    fetchNotes,
    createNote,
  };
}
