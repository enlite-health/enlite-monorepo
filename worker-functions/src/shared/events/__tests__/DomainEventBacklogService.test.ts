import { DomainEventBacklogService } from '../DomainEventBacklogService';

describe('DomainEventBacklogService.getBacklogSummary — stuck só para eventos com handler', () => {
  const makeService = (rows: unknown[]) => {
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    return new DomainEventBacklogService(pool as never);
  };

  // backlog "velho" (90 min > threshold 15) para forçar stuck quando aplicável
  const oldRow = (event: string) => ({
    event,
    pending_total: 50,
    pending_recent: 2,
    oldest_recent_created_at: new Date(Date.now() - 90 * 60_000),
    failed_total: 0,
  });

  it('evento COM handler e backlog velho → stuck=true, unhandled=false', async () => {
    const svc = makeService([oldRow('vacancy.created')]);
    const [row] = await svc.getBacklogSummary(6, 15, ['vacancy.created']);
    expect(row.stuck).toBe(true);
    expect(row.unhandled).toBe(false);
  });

  it('evento SEM handler (órfão) → nunca stuck, marcado unhandled=true', async () => {
    const svc = makeService([oldRow('funnel_stage.rejected')]);
    const [row] = await svc.getBacklogSummary(6, 15, ['vacancy.created', 'worker.registration_completed']);
    expect(row.stuck).toBe(false);
    expect(row.unhandled).toBe(true);
  });

  it('sem lista de handlers (undefined) → compat legado: avalia todos', async () => {
    const svc = makeService([oldRow('qualquer.evento')]);
    const [row] = await svc.getBacklogSummary(6, 15);
    expect(row.stuck).toBe(true);
    expect(row.unhandled).toBe(false);
  });
});
