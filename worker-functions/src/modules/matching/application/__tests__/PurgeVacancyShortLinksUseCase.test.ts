/**
 * PurgeVacancyShortLinksUseCase.test.ts
 *
 * Scenarios:
 *   1. Deletes every link with an id and clears the column
 *   2. No-op (no Short.io call, empty result) when there are no stored links
 *   3. Throws when vacancy not found
 *   4. Keeps failed deletions in the DB for retry
 *   5. Skips legacy string-format links (no id) and keeps them
 *   6. Idempotent: re-run on an already-empty vacancy does nothing
 */

import { PurgeVacancyShortLinksUseCase } from '../PurgeVacancyShortLinksUseCase';
import { ShortLinkService } from '../../infrastructure/shortlinks/ShortLinkService';

const mockQuery = jest.fn();
const mockDelete = jest.fn();

const mockPool = { query: mockQuery } as unknown as import('pg').Pool;
const mockShortLinkService = {
  delete: mockDelete,
} as unknown as ShortLinkService;

describe('PurgeVacancyShortLinksUseCase', () => {
  let useCase: PurgeVacancyShortLinksUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new PurgeVacancyShortLinksUseCase(mockPool, mockShortLinkService);
  });

  const VACANCY_ID = 'vac-uuid-001';

  it('deletes every link with an id and clears the column', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          social_short_links: {
            facebook: { url: 'https://srt.io/fb', id: 'fb-id' },
            site: { url: 'https://srt.io/site', id: 'site-id' },
          },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE
    mockDelete.mockResolvedValue(undefined);

    const result = await useCase.execute(VACANCY_ID);

    expect(result).toEqual({ deleted: 2, failed: 0, skipped: 0 });
    expect(mockDelete).toHaveBeenCalledWith('fb-id');
    expect(mockDelete).toHaveBeenCalledWith('site-id');

    const [updateSql, updateParams] = mockQuery.mock.calls[1];
    expect(updateSql).toContain('UPDATE job_postings');
    expect(updateParams[1]).toBe(VACANCY_ID);
    expect(JSON.parse(updateParams[0] as string)).toEqual({});
  });

  it('is a no-op when the vacancy has no stored links', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ social_short_links: {} }] });

    const result = await useCase.execute(VACANCY_ID);

    expect(result).toEqual({ deleted: 0, failed: 0, skipped: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1); // no UPDATE
  });

  it('throws when vacancy not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(useCase.execute(VACANCY_ID)).rejects.toThrow(`Vacancy ${VACANCY_ID} not found`);
  });

  it('keeps failed deletions in the DB for retry', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          social_short_links: {
            facebook: { url: 'https://srt.io/fb', id: 'fb-id' },
            site: { url: 'https://srt.io/site', id: 'site-id' },
          },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockDelete
      .mockResolvedValueOnce(undefined) // fb-id ok
      .mockRejectedValueOnce(new Error('Short.io 500')); // site-id fails

    const result = await useCase.execute(VACANCY_ID);

    expect(result).toEqual({ deleted: 1, failed: 1, skipped: 0 });
    const [, updateParams] = mockQuery.mock.calls[1];
    const remaining = JSON.parse(updateParams[0] as string);
    expect(remaining.facebook).toBeUndefined();
    expect(remaining.site).toEqual({ url: 'https://srt.io/site', id: 'site-id' });
  });

  it('skips and keeps legacy string-format links with no id', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          social_short_links: {
            facebook: 'https://srt.io/fb-legacy',
            site: { url: 'https://srt.io/site', id: 'site-id' },
          },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockDelete.mockResolvedValue(undefined);

    const result = await useCase.execute(VACANCY_ID);

    expect(result).toEqual({ deleted: 1, failed: 0, skipped: 1 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('site-id');

    const [, updateParams] = mockQuery.mock.calls[1];
    const remaining = JSON.parse(updateParams[0] as string);
    expect(remaining).toEqual({ facebook: 'https://srt.io/fb-legacy' });
  });
});
