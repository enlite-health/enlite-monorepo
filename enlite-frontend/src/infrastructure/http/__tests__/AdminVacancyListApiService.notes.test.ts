import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AdminVacancyListApiService } from '../AdminVacancyListApiService';
import type { VacancyNote } from '@domain/entities/VacancyNote';

// Mock FirebaseAuthService so no real Firebase initialisation is required.
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

describe('AdminVacancyListApiService — notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  function stubFetch(body: unknown) {
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve(body),
    });
  }

  function capturedCall(): [string, RequestInit] {
    const call = (global.fetch as Mock).mock.calls[0];
    return [call[0] as string, call[1] as RequestInit];
  }

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

  describe('listVacancyNotes', () => {
    it('calls GET /api/admin/vacancies/:id/notes', async () => {
      stubFetch({ success: true, data: [sampleNote] });
      const result = await AdminVacancyListApiService.listVacancyNotes('vacancy-1');
      const [url, init] = capturedCall();
      expect(url).toContain('/api/admin/vacancies/vacancy-1/notes');
      expect(init.method).toBe('GET');
      expect(result).toEqual([sampleNote]);
    });

    it('throws when success is false', async () => {
      stubFetch({ success: false, error: 'Forbidden' });
      await expect(
        AdminVacancyListApiService.listVacancyNotes('vacancy-1'),
      ).rejects.toThrow('Forbidden');
    });
  });

  describe('createVacancyNote', () => {
    it('calls POST /api/admin/vacancies/:id/notes with JSON body', async () => {
      stubFetch({ success: true, data: sampleNote });
      const payload = {
        occurredAt: '2026-09-20T10:00:00.000Z',
        category: 'DIVULGACAO' as const,
        contact: 'grupo Facebook X',
        body: 'Publicado no grupo',
      };
      const result = await AdminVacancyListApiService.createVacancyNote('vacancy-1', payload);
      const [url, init] = capturedCall();
      expect(url).toContain('/api/admin/vacancies/vacancy-1/notes');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(payload);
      expect(result).toEqual(sampleNote);
    });

    it('throws when success is false', async () => {
      stubFetch({ success: false, error: 'Bad Request' });
      await expect(
        AdminVacancyListApiService.createVacancyNote('vacancy-1', {
          occurredAt: '2026-09-20T10:00:00.000Z',
          category: 'OUTRO',
          contact: 'x',
          body: 'y',
        }),
      ).rejects.toThrow('Bad Request');
    });
  });
});
