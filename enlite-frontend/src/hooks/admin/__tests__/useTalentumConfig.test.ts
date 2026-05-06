import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTalentumConfig } from '../useTalentumConfig';

// ---------------------------------------------------------------------------
// Mock AdminApiService
// ---------------------------------------------------------------------------

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getVacancyById: vi.fn(),
    generateAIContent: vi.fn(),
    savePrescreeningConfig: vi.fn(),
    publishToTalentum: vi.fn(),
  },
}));

import { AdminApiService } from '@infrastructure/http/AdminApiService';

const mockGetVacancy = vi.mocked(AdminApiService.getVacancyById);
const mockGenerateAI = vi.mocked(AdminApiService.generateAIContent);
const mockSavePresc = vi.mocked(AdminApiService.savePrescreeningConfig);
const mockPublish = vi.mocked(AdminApiService.publishToTalentum);

const VACANCY_ID = 'vac-test-1';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 42,
  vacancy_number: 2,
  patient_first_name: 'Ana',
  patient_last_name: 'García',
  status: 'PENDING_ACTIVATION',
  talentum_published_at: null,
  closed_at: null,
};

const MOCK_AI_RESULT = {
  description: 'Descripción generada por IA',
  prescreening: {
    questions: [
      {
        question: '¿Tenés experiencia con TEA?',
        responseType: ['text'],
        desiredResponse: 'Sí',
        weight: 8,
        required: true,
        analyzed: true,
        earlyStoppage: false,
      },
    ],
    faq: [
      { question: '¿Cuál es el horario?', answer: 'Lunes a viernes 9-17hs' },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVacancy.mockResolvedValue(MOCK_VACANCY as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTalentumConfig', () => {
  it('fetches vacancy on mount and populates vacancyData', async () => {
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    expect(result.current.isLoadingVacancy).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoadingVacancy).toBe(false);
    });

    expect(result.current.vacancyData).toMatchObject({
      caseNumber: 42,
      vacancyNumber: 2,
      patientFirstName: 'Ana',
      patientLastName: 'García',
      status: 'PENDING_ACTIVATION',
    });
    expect(mockGetVacancy).toHaveBeenCalledWith(VACANCY_ID);
  });

  it('sets vacancyError on fetch failure', async () => {
    mockGetVacancy.mockRejectedValueOnce(new Error('Not found'));
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => {
      expect(result.current.isLoadingVacancy).toBe(false);
    });

    expect(result.current.vacancyError).toBe('Not found');
    expect(result.current.vacancyData).toBeNull();
  });

  it('generateAIContent populates description and prescreening', async () => {
    mockGenerateAI.mockResolvedValueOnce(MOCK_AI_RESULT as any);
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => !result.current.isLoadingVacancy);

    await act(async () => {
      await result.current.generateAIContent();
    });

    expect(result.current.description).toBe('Descripción generada por IA');
    expect(result.current.prescreeningQuestions).toHaveLength(1);
    expect(result.current.prescreeningFaq).toHaveLength(1);
    expect(result.current.generateStatus).toBe('success');
  });

  it('generateAIContent sets error status on failure', async () => {
    mockGenerateAI.mockRejectedValueOnce(new Error('AI timeout'));
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => !result.current.isLoadingVacancy);

    await act(async () => {
      await result.current.generateAIContent();
    });

    expect(result.current.generateStatus).toBe('error');
    expect(result.current.generateError).toBe('AI timeout');
  });

  it('savePrescreening calls API and updates local state', async () => {
    mockSavePresc.mockResolvedValueOnce({ questions: [], faq: [] } as any);
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => !result.current.isLoadingVacancy);

    const payload = { questions: MOCK_AI_RESULT.prescreening.questions as any, faq: [] };

    await act(async () => {
      await result.current.savePrescreening(payload);
    });

    expect(mockSavePresc).toHaveBeenCalledWith(VACANCY_ID, payload);
    expect(result.current.prescreeningQuestions).toEqual(payload.questions);
  });

  it('savePrescreening propagates error', async () => {
    mockSavePresc.mockRejectedValueOnce(new Error('Save failed'));
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => !result.current.isLoadingVacancy);

    let thrownSave: unknown;
    await act(async () => {
      try {
        await result.current.savePrescreening({ questions: [], faq: [] });
      } catch (e) {
        thrownSave = e;
      }
    });

    expect((thrownSave as Error)?.message).toBe('Save failed');
    expect(result.current.saveError).toBe('Save failed');
  });

  it('publish calls publishToTalentum and re-fetches vacancy', async () => {
    const updatedVacancy = { ...MOCK_VACANCY, talentum_published_at: '2026-05-01T10:00:00Z' };
    mockPublish.mockResolvedValueOnce({ projectId: 'p1', publicId: 'pub1', whatsappUrl: 'wa.me/test' });
    // First getVacancyById for mount (already set in beforeEach), second for post-publish refetch
    mockGetVacancy.mockResolvedValueOnce(MOCK_VACANCY as any).mockResolvedValueOnce(updatedVacancy as any);
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => !result.current.isLoadingVacancy);

    await act(async () => {
      await result.current.publish();
    });

    expect(mockPublish).toHaveBeenCalledWith(VACANCY_ID);
    await waitFor(() => {
      expect(result.current.vacancyData?.publishedAt).toBe('2026-05-01T10:00:00Z');
    });
  });

  it('publish sets publishError and throws on failure', async () => {
    mockPublish.mockRejectedValueOnce(new Error('Publish failed'));
    const { result } = renderHook(() => useTalentumConfig(VACANCY_ID));

    await waitFor(() => !result.current.isLoadingVacancy);

    let thrownPublish: unknown;
    await act(async () => {
      try {
        await result.current.publish();
      } catch (e) {
        thrownPublish = e;
      }
    });

    expect((thrownPublish as Error)?.message).toBe('Publish failed');
    expect(result.current.publishError).toBe('Publish failed');
  });
});
