import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVacancyNotes } from '../useVacancyNotes';
import { AdminVacancyListApiService } from '@infrastructure/http/AdminVacancyListApiService';
import type { VacancyNote } from '@domain/entities/VacancyNote';

vi.mock('@infrastructure/http/AdminVacancyListApiService');

const sampleNote: VacancyNote = {
  id: 'note-1',
  jobPostingId: 'vacancy-1',
  occurredAt: '2026-09-20T10:00:00.000Z',
  category: 'DIVULGACAO',
  contact: 'grupo Facebook X',
  body: 'Publicado no grupo',
  createdBy: 'staff:abc',
  authorEmail: 'staff@enlite.health',
  createdAt: '2026-09-20T10:00:01.000Z',
};

describe('useVacancyNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchNotes busca a lista e expõe no estado', async () => {
    const spy = vi
      .spyOn(AdminVacancyListApiService, 'listVacancyNotes')
      .mockResolvedValue([sampleNote]);

    const { result } = renderHook(() => useVacancyNotes('vacancy-1'));

    expect(result.current.notes).toEqual([]);

    await act(async () => {
      await result.current.fetchNotes();
    });

    expect(spy).toHaveBeenCalledWith('vacancy-1');
    expect(result.current.notes).toEqual([sampleNote]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('erro no fetchNotes vira mensagem em error, sem quebrar', async () => {
    vi.spyOn(AdminVacancyListApiService, 'listVacancyNotes').mockRejectedValue(
      new Error('Forbidden'),
    );

    const { result } = renderHook(() => useVacancyNotes('vacancy-1'));

    await act(async () => {
      await result.current.fetchNotes();
    });

    expect(result.current.error).toBe('Forbidden');
    expect(result.current.notes).toEqual([]);
  });

  it('createNote chama o POST e relê a lista (list de novo)', async () => {
    const listSpy = vi
      .spyOn(AdminVacancyListApiService, 'listVacancyNotes')
      .mockResolvedValue([sampleNote]);
    const createSpy = vi
      .spyOn(AdminVacancyListApiService, 'createVacancyNote')
      .mockResolvedValue(sampleNote);

    const { result } = renderHook(() => useVacancyNotes('vacancy-1'));

    const payload = {
      occurredAt: '2026-09-20T10:00:00.000Z',
      category: 'DIVULGACAO' as const,
      contact: 'grupo Facebook X',
      body: 'Publicado no grupo',
    };

    await act(async () => {
      await result.current.createNote(payload);
    });

    expect(createSpy).toHaveBeenCalledWith('vacancy-1', payload);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(result.current.notes).toEqual([sampleNote]);
  });

  it('erro do POST vira error e é relançado (formulário mantém os campos)', async () => {
    vi.spyOn(AdminVacancyListApiService, 'createVacancyNote').mockRejectedValue(
      new Error('Bad Request'),
    );

    const { result } = renderHook(() => useVacancyNotes('vacancy-1'));

    const payload = {
      occurredAt: '2026-09-20T10:00:00.000Z',
      category: 'OUTRO' as const,
      contact: 'x',
      body: 'y',
    };

    await act(async () => {
      await expect(result.current.createNote(payload)).rejects.toThrow('Bad Request');
    });

    expect(result.current.error).toBe('Bad Request');
    expect(result.current.isCreating).toBe(false);
  });
});
