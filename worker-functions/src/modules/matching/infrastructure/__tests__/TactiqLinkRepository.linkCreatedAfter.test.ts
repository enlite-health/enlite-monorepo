/** `linkCreatedAfter`: compara tactiq_links.created_at com o instante dado. */
import { TactiqLinkRepository } from '../TactiqLinkRepository';

describe('TactiqLinkRepository.linkCreatedAfter', () => {
  const query = jest.fn();
  const repo = new TactiqLinkRepository({ query } as never);
  const at = new Date('2026-11-02T15:00:00Z');

  it('compara tactiq_links.created_at (1º vínculo) com o instante dado', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    expect(await repo.linkCreatedAfter('Op@Enlite.test', at)).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('created_at > $2::timestamptz');
    expect(params).toEqual(['Op@Enlite.test', at]);
  });

  it('sem linha → false', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await repo.linkCreatedAfter('x@y.test', at)).toBe(false);
  });
});
