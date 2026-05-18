/**
 * PublishVacancyToTalentumUseCase — Unit Tests
 *
 * Coverage: publish() happy path, all error paths (404, 409, 400, 502),
 * description auto-generation, FAQ handling, DB transactions,
 * unpublish() happy path + all error paths, and PublishError class.
 *
 * Mocks: DatabaseConnection, TalentumDescriptionService, TalentumApiClient.
 */

// ── Mocks ────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();

const mockPool = {
  query: mockPoolQuery,
  connect: jest.fn().mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  }),
};

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({
      getPool: () => mockPool,
    }),
  },
}));

const mockGenerateDescription = jest.fn();
jest.mock('../../../src/modules/integration/infrastructure/TalentumDescriptionService', () => ({
  TalentumDescriptionService: jest.fn().mockImplementation(() => ({
    generateDescription: mockGenerateDescription,
  })),
}));

const mockCreatePrescreening = jest.fn();
const mockGetPrescreening = jest.fn();
const mockDeletePrescreening = jest.fn();
const mockTalentumCreate = jest.fn();

jest.mock('../../../src/modules/integration/infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: {
    create: () => mockTalentumCreate(),
  },
}));

import {
  PublishVacancyToTalentumUseCase,
  PublishError,
} from '../../../src/modules/integration/application/PublishVacancyToTalentumUseCase';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTalentumClient() {
  return {
    createPrescreening: mockCreatePrescreening,
    getPrescreening: mockGetPrescreening,
    deletePrescreening: mockDeletePrescreening,
  };
}

function setupVacancyRow(overrides: Record<string, any> = {}) {
  return {
    id: 'job-123',
    title: 'Caso 747',
    talentum_project_id: null,
    talentum_description: 'Pre-existing description',
    ...overrides,
  };
}

function setupQuestionsRows(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `q-${i + 1}`,
    question: `Question ${i + 1}?`,
    response_type: ['text', 'audio'],
    desired_response: `Expected answer ${i + 1}`,
    weight: 5 + i,
    required: false,
    analyzed: true,
    early_stoppage: false,
  }));
}

function setupFaqRows(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    question: `FAQ ${i + 1}?`,
    answer: `Answer ${i + 1}`,
  }));
}

// Reset all mocks before each test
beforeEach(() => {
  mockPoolQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPool.connect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
  mockGenerateDescription.mockReset();
  mockCreatePrescreening.mockReset();
  mockGetPrescreening.mockReset();
  mockDeletePrescreening.mockReset();
  mockTalentumCreate.mockReset();
  mockTalentumCreate.mockResolvedValue(makeTalentumClient());
});

// ── Tests ────────────────────────────────────────────────────────────

describe('PublishVacancyToTalentumUseCase', () => {
  // ── publish() happy path ─────────────────────────────────────────
  describe('publish() — happy path', () => {
    it('publishes vacancy with existing description', async () => {
      // 1. Vacancy query
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        // 2. Questions query
        .mockResolvedValueOnce({ rows: setupQuestionsRows(2) })
        // 3. FAQ query
        .mockResolvedValueOnce({ rows: setupFaqRows(1) });

      // 4. Talentum create
      mockCreatePrescreening.mockResolvedValue({ projectId: 'proj-001', publicId: 'pub-001' });

      // 5. Talentum get
      mockGetPrescreening.mockResolvedValue({
        whatsappUrl: 'https://wa.me/123?text=hi',
        slug: '#abc123',
      });

      // 6. DB transaction (BEGIN, UPDATE, COMMIT)
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      const result = await useCase.publish({ jobPostingId: 'job-123' });

      expect(result).toEqual({
        projectId: 'proj-001',
        publicId: 'pub-001',
        whatsappUrl: 'https://wa.me/123?text=hi',
      });

      // Verify transaction was used
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('auto-generates description when talentum_description is null (CA-4.3)', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow({ talentum_description: null })] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: setupFaqRows(0) });

      mockGenerateDescription.mockResolvedValue({
        title: 'Caso 747',
        description: 'Auto-generated description\n\nEl Marco...',
      });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'https://wa.me/1', slug: '#s' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockGenerateDescription).toHaveBeenCalledWith('job-123');
    });

    it('skips description generation when talentum_description exists', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow({ talentum_description: 'Existing desc' })] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: setupFaqRows(0) });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockGenerateDescription).not.toHaveBeenCalled();
    });

    it('maps questions correctly to Talentum format', async () => {
      const questions = [
        {
          id: 'q1',
          question: 'Experience?',
          response_type: ['text'],
          desired_response: '6 months',
          weight: 8,
          required: true,
          analyzed: true,
          early_stoppage: false,
        },
      ];

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: questions })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockCreatePrescreening).toHaveBeenCalledWith(
        expect.objectContaining({
          questions: [
            expect.objectContaining({
              question: 'Experience?',
              type: 'text',
              responseType: ['text'],
              desiredResponse: '6 months',
              weight: 8,
              required: true,
              analyzed: true,
              earlyStoppage: false,
            }),
          ],
        })
      );
    });

    it('defaults response_type to [text, audio] when null', async () => {
      const questions = [{
        id: 'q1',
        question: 'Q?',
        response_type: null,
        desired_response: 'A',
        weight: 5,
        required: false,
        analyzed: true,
        early_stoppage: false,
      }];

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: questions })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockCreatePrescreening).toHaveBeenCalledWith(
        expect.objectContaining({
          questions: [expect.objectContaining({ responseType: ['text', 'audio'] })],
        })
      );
    });

    it('passes FAQ when available', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [{ question: 'Salary?', answer: 'TBD' }] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockCreatePrescreening).toHaveBeenCalledWith(
        expect.objectContaining({
          faq: [{ question: 'Salary?', answer: 'TBD' }],
        })
      );
    });

    it('omits FAQ when empty', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] }); // No FAQ

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockCreatePrescreening).toHaveBeenCalledWith(
        expect.objectContaining({
          faq: undefined,
        })
      );
    });

    it('uses vacancy title, fallback to "Caso {id}" when null', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow({ title: null })] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      expect(mockCreatePrescreening).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Caso job-123',
        })
      );
    });

    it('saves all Talentum references in transaction (CA-4.7)', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'proj-X', publicId: 'pub-X' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'https://wa.me/X', slug: '#slugX' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      // Verify UPDATE inside transaction
      const updateCall = mockClientQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE job_postings')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual(['proj-X', 'pub-X', 'https://wa.me/X', '#slugX', 'job-123']);
    });

    it('flips is_draft to false when publishing (migration 168 contract)', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.publish({ jobPostingId: 'job-123' });

      const updateCall = mockClientQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE job_postings')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toMatch(/is_draft\s*=\s*false/);
    });
  });

  // ── publish() error paths ────────────────────────────────────────
  describe('publish() — error paths', () => {
    it('throws 404 when vacancy not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.publish({ jobPostingId: 'missing' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(404);
        expect(err.message).toContain('not found');
      }
    });

    it('throws 409 when already published (CA-4.2)', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [setupVacancyRow({ talentum_project_id: 'existing-proj' })],
      });

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.publish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(409);
        expect(err.message).toContain('already published');
      }
    });

    it('throws 400 when no prescreening questions (CA-4.1)', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] }); // No questions

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.publish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('No prescreening questions');
      }
    });

    it('throws 502 when TalentumApiClient.create() fails (CA-4.6)', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockTalentumCreate.mockRejectedValue(new Error('Secret Manager unreachable'));

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.publish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(502);
        expect(err.message).toContain('Failed to initialize Talentum client');
      }
    });

    it('throws 502 when createPrescreening fails', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockRejectedValue(new Error('HTTP 500: Server Error'));

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.publish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(502);
        expect(err.message).toContain('Talentum API error (create)');
      }
    });

    it('throws 502 when getPrescreening fails', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockRejectedValue(new Error('HTTP 404: Not Found'));

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.publish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(502);
        expect(err.message).toContain('Talentum API error (get)');
      }
    });

    it('rolls back transaction when DB update fails', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [setupVacancyRow()] })
        .mockResolvedValueOnce({ rows: setupQuestionsRows() })
        .mockResolvedValueOnce({ rows: [] });

      mockCreatePrescreening.mockResolvedValue({ projectId: 'p1', publicId: 'u1' });
      mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'url', slug: 's' });

      // BEGIN succeeds, UPDATE fails
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB write error')) // UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      const useCase = new PublishVacancyToTalentumUseCase();
      await expect(useCase.publish({ jobPostingId: 'job-123' }))
        .rejects.toThrow('DB write error');

      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });

  // ── unpublish() ──────────────────────────────────────────────────
  describe('unpublish()', () => {
    it('happy path: deletes from Talentum and clears DB columns', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ talentum_project_id: 'proj-to-remove' }],
      });

      mockDeletePrescreening.mockResolvedValue(undefined);
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.unpublish({ jobPostingId: 'job-123' });

      expect(mockDeletePrescreening).toHaveBeenCalledWith('proj-to-remove');

      // Verify NULLing transaction
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      const updateCall = mockClientQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('SET talentum_project_id   = NULL')
      );
      expect(updateCall).toBeDefined();
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('flips is_draft back to true when unpublishing (migration 168 contract)', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ talentum_project_id: 'proj-X' }],
      });
      mockDeletePrescreening.mockResolvedValue(undefined);
      mockClientQuery.mockResolvedValue({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.unpublish({ jobPostingId: 'job-123' });

      const updateCall = mockClientQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE job_postings')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toMatch(/is_draft\s*=\s*true/);
    });

    it('throws 404 when vacancy not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.unpublish({ jobPostingId: 'missing' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(404);
      }
    });

    it('throws 400 when vacancy is not published', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ talentum_project_id: null }],
      });

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.unpublish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('not published');
      }
    });

    it('throws 502 when Talentum delete fails', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ talentum_project_id: 'proj-X' }],
      });

      mockTalentumCreate.mockRejectedValue(new Error('Connection refused'));

      const useCase = new PublishVacancyToTalentumUseCase();
      try {
        await useCase.unpublish({ jobPostingId: 'job-123' });
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PublishError);
        expect(err.statusCode).toBe(502);
        expect(err.message).toContain('Talentum API error (delete)');
      }
    });

    it('rolls back transaction when DB clear fails', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ talentum_project_id: 'proj-X' }],
      });

      mockDeletePrescreening.mockResolvedValue(undefined);

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')) // UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      const useCase = new PublishVacancyToTalentumUseCase();
      await expect(useCase.unpublish({ jobPostingId: 'job-123' }))
        .rejects.toThrow('DB error');

      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });

  // ── PublishError class ───────────────────────────────────────────
  describe('PublishError', () => {
    it('has statusCode and message properties', () => {
      const err = new PublishError(409, 'Already published');
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe('Already published');
      expect(err.name).toBe('PublishError');
    });

    it('is an instance of Error', () => {
      const err = new PublishError(500, 'Server error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PublishError);
    });
  });
});
