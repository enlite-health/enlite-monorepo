import { describe, it, expect, vi, beforeEach } from 'vitest';

// FirebaseAuthService is constructed at module load — mock it so getIdToken
// doesn't touch real Firebase.
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('test-token'),
  })),
}));

import { AdminTalentumApiService } from '../AdminTalentumApiService';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('AdminTalentumApiService.request error handling', () => {
  it('surfaces backend `details` (real cause) in the thrown error message', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        error: 'Failed to generate AI content',
        details: 'Vertex AI: could not obtain an ADC access token',
      }),
    );

    await expect(AdminTalentumApiService.generateAIContent('vac-1')).rejects.toThrow(
      'Failed to generate AI content: Vertex AI: could not obtain an ADC access token',
    );
  });

  it('falls back to `error` when no details are present', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Vacancy not found' }),
    );

    await expect(AdminTalentumApiService.generateAIContent('vac-1')).rejects.toThrow(
      'Vacancy not found',
    );
  });

  it('returns data on success', async () => {
    const data = { description: 'x', prescreening: { questions: [], faq: [] } };
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data }));

    await expect(AdminTalentumApiService.generateAIContent('vac-1')).resolves.toEqual(data);
  });
});
