/** `hasImportedSinceLinked`: cobre as DUAS fontes (admissão e enquadre), só `done`, só desde o `created_at` do vínculo. */
import { TactiqLinkRepository } from '../TactiqLinkRepository';

describe('TactiqLinkRepository.hasImportedSinceLinked', () => {
  const query = jest.fn();
  const repo = new TactiqLinkRepository({ query } as never);

  it('consulta admissão e enquadre, só import_status=done, desde tactiq_links.created_at', async () => {
    query.mockResolvedValue({ rows: [{ imported: true }] });
    expect(await repo.hasImportedSinceLinked('Op@Enlite.test')).toBe(true);
    const [sql, params] = query.mock.calls[0];
    for (const t of ['admission_appointments', 'admission_events', 'enquadre_events', 'enquadre_event_trail', 'tactiq_links']) expect(sql).toContain(t);
    expect(sql).toContain("import_status = 'done'");
    expect(sql).toContain('>= l.created_at');
    expect(params).toEqual(['Op@Enlite.test']);
  });

  it('sem linha ou false → false', async () => {
    query.mockResolvedValue({ rows: [{ imported: false }] });
    expect(await repo.hasImportedSinceLinked('x@y.test')).toBe(false);
    query.mockResolvedValue({ rows: [] });
    expect(await repo.hasImportedSinceLinked('x@y.test')).toBe(false);
  });
});

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
