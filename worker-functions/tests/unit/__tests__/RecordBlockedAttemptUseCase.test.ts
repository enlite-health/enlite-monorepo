/**
 * RecordBlockedAttemptUseCase — Unit Tests
 *
 * Cobre 100% de linhas/branches/funcs/stmts:
 *   - Caminho feliz: delega ao repo sem lançar, retorna missingFields do repo
 *   - Falha no repo: captura, loga warn, NÃO propaga (fire-and-forget), retorna []
 *   - Todos os reason values do union type
 *   - acquisitionChannel null e string
 */

// ── Mocks (hoist antes dos imports) ──────────────────────────────────

const mockUpsert = jest.fn();

jest.mock(
  '../../../src/modules/matching/infrastructure/BlockedApplicationRepository',
  () => ({
    BlockedApplicationRepository: jest.fn().mockImplementation(() => ({
      upsert: mockUpsert,
    })),
  }),
);

// logger.warn precisa existir; não queremos side-effects reais
const mockLoggerWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: {
    warn: mockLoggerWarn,
    child: jest.fn().mockReturnValue({ warn: mockLoggerWarn, info: jest.fn() }),
    info: jest.fn(),
  },
  reportError: jest.fn(),
}));

import { RecordBlockedAttemptUseCase } from '../../../src/modules/matching/application/RecordBlockedAttemptUseCase';

// ── Helpers ──────────────────────────────────────────────────────────

const BASE_PARAMS = {
  workerId: 'worker-uuid-001',
  jobPostingId: 'job-uuid-001',
  reason: 'registration_incomplete' as const,
  acquisitionChannel: 'facebook',
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('RecordBlockedAttemptUseCase', () => {
  let useCase: RecordBlockedAttemptUseCase;

  beforeEach(() => {
    mockUpsert.mockReset();
    mockLoggerWarn.mockReset();
    useCase = new RecordBlockedAttemptUseCase();
  });

  // ── Caminho feliz ─────────────────────────────────────────────────

  describe('caminho feliz — repo bem-sucedido', () => {
    it('resolve sem lançar quando upsert tem sucesso, retorna array de missingFields', async () => {
      mockUpsert.mockResolvedValueOnce(['first_name', 'phone']);

      await expect(useCase.execute(BASE_PARAMS)).resolves.toEqual(['first_name', 'phone']);
    });

    it('chama repo.upsert com os params corretos', async () => {
      mockUpsert.mockResolvedValueOnce([]);

      await useCase.execute(BASE_PARAMS);

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledWith({
        workerId: BASE_PARAMS.workerId,
        jobPostingId: BASE_PARAMS.jobPostingId,
        reason: BASE_PARAMS.reason,
        acquisitionChannel: BASE_PARAMS.acquisitionChannel,
      });
    });

    it('aceita acquisitionChannel null', async () => {
      mockUpsert.mockResolvedValueOnce([]);
      const params = { ...BASE_PARAMS, acquisitionChannel: null };

      await expect(useCase.execute(params)).resolves.toEqual([]);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ acquisitionChannel: null }),
      );
    });

    it('aceita reason=worker_not_found', async () => {
      mockUpsert.mockResolvedValueOnce(['worker_not_found']);
      const params = { ...BASE_PARAMS, reason: 'worker_not_found' as const };

      await expect(useCase.execute(params)).resolves.toEqual(['worker_not_found']);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'worker_not_found' }),
      );
    });

    it('aceita reason=worker_disabled', async () => {
      mockUpsert.mockResolvedValueOnce([]);
      const params = { ...BASE_PARAMS, reason: 'worker_disabled' as const };

      await expect(useCase.execute(params)).resolves.toEqual([]);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'worker_disabled' }),
      );
    });

    it('não chama logger.warn quando sucesso', async () => {
      mockUpsert.mockResolvedValueOnce([]);

      await useCase.execute(BASE_PARAMS);

      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });
  });

  // ── Caminho de falha (fire-and-forget) ───────────────────────────

  describe('caminho de falha — repo lança (fire-and-forget)', () => {
    it('NÃO propaga erro quando repo lança — retorna [] sem lançar', async () => {
      mockUpsert.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(useCase.execute(BASE_PARAMS)).resolves.toEqual([]);
    });

    it('loga warn quando repo lança (com Error)', async () => {
      const err = new Error('unique violation');
      mockUpsert.mockRejectedValueOnce(err);

      await useCase.execute(BASE_PARAMS);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: BASE_PARAMS.workerId,
          jobPostingId: BASE_PARAMS.jobPostingId,
          reason: BASE_PARAMS.reason,
          error: 'unique violation',
        }),
      );
    });

    it('loga warn quando repo lança (com valor não-Error)', async () => {
      mockUpsert.mockRejectedValueOnce('string error');

      await useCase.execute(BASE_PARAMS);

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'string error',
        }),
      );
    });

    it('o 403 não é bloqueado — resolve mesmo se record falhar', async () => {
      mockUpsert.mockRejectedValueOnce(new Error('timeout'));

      const start = Date.now();
      const result = await useCase.execute(BASE_PARAMS);
      const elapsed = Date.now() - start;

      // Prova que não ficou travado — deve completar muito rápido
      expect(elapsed).toBeLessThan(500);
      expect(result).toEqual([]);

      mockUpsert.mockResolvedValueOnce([]);
      await expect(useCase.execute(BASE_PARAMS)).resolves.toEqual([]);
    });

    it('falha com reason=worker_not_found: loga reason correto', async () => {
      mockUpsert.mockRejectedValueOnce(new Error('fail'));
      const params = { ...BASE_PARAMS, reason: 'worker_not_found' as const };

      await useCase.execute(params);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'worker_not_found' }),
      );
    });

    it('falha com reason=worker_disabled: loga reason correto', async () => {
      mockUpsert.mockRejectedValueOnce(new Error('fail'));
      const params = { ...BASE_PARAMS, reason: 'worker_disabled' as const };

      await useCase.execute(params);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'worker_disabled' }),
      );
    });
  });
});
