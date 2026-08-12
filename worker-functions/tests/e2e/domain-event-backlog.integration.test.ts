/**
 * domain-event-backlog.integration.test.ts
 *
 * Teste de integração com banco REAL para DomainEventBacklogService.
 * Não usa API — acessa pool diretamente e instancia o serviço.
 *
 * Cobre:
 *   - pendingTotal/pendingRecent/failedTotal por tipo de evento
 *   - oldestRecentAgeMinutes calculado a partir do pending recente mais antigo
 *   - stuck=true quando oldestRecentAgeMinutes > stuckThresholdMinutes
 *   - evento sem nenhum pending/failed não aparece no summary (ruído zero)
 */

import { Pool } from 'pg';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DomainEventBacklogService } = require('../../src/shared/events/DomainEventBacklogService') as typeof import('../../src/shared/events/DomainEventBacklogService');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const EVENT_STUCK = `e2e.backlog.stuck.${SUFFIX}`;
const EVENT_HEALTHY = `e2e.backlog.healthy.${SUFFIX}`;
const EVENT_OLD_ONLY = `e2e.backlog.old-only.${SUFFIX}`;
const EVENT_ALL_PROCESSED = `e2e.backlog.processed-only.${SUFFIX}`;

const ALL_EVENT_NAMES = [EVENT_STUCK, EVENT_HEALTHY, EVENT_OLD_ONLY, EVENT_ALL_PROCESSED];

async function insertEvent(
  event: string,
  status: 'pending' | 'processed' | 'failed',
  createdAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO domain_events (event, payload, status, created_at)
     VALUES ($1, '{}'::jsonb, $2, $3)`,
    [event, status, createdAt.toISOString()],
  );
}

beforeAll(async () => {
  const now = Date.now();

  // EVENT_STUCK: 1 pending recente há 30min (dentro da janela de 6h) + 1 failed antigo
  await insertEvent(EVENT_STUCK, 'pending', new Date(now - 30 * 60_000));
  await insertEvent(EVENT_STUCK, 'failed', new Date(now - 2 * 60 * 60_000));

  // EVENT_HEALTHY: 1 pending recente há 2min (não passa do threshold de 15min)
  await insertEvent(EVENT_HEALTHY, 'pending', new Date(now - 2 * 60_000));

  // EVENT_OLD_ONLY: 1 pending fora da janela recente (8h atrás, janela=6h) — não conta
  // como pendingRecent, mas conta em pendingTotal.
  await insertEvent(EVENT_OLD_ONLY, 'pending', new Date(now - 8 * 60 * 60_000));

  // EVENT_ALL_PROCESSED: só tem processed — não deve aparecer no summary (ruído zero).
  await insertEvent(EVENT_ALL_PROCESSED, 'processed', new Date(now - 60_000));
});

afterAll(async () => {
  await pool.query('DELETE FROM domain_events WHERE event = ANY($1::text[])', [ALL_EVENT_NAMES]);
  await pool.end();
});

describe('DomainEventBacklogService (banco real)', () => {
  it('reports pendingTotal/pendingRecent/failedTotal/oldestRecentAgeMinutes/stuck per event', async () => {
    const service = new DomainEventBacklogService(pool);
    const summary = await service.getBacklogSummary(6, 15);

    const byEvent = new Map(summary.map(row => [row.event, row]));

    const stuckRow = byEvent.get(EVENT_STUCK);
    expect(stuckRow).toBeDefined();
    expect(stuckRow!.pendingTotal).toBe(1);
    expect(stuckRow!.pendingRecent).toBe(1);
    expect(stuckRow!.failedTotal).toBe(1);
    expect(stuckRow!.oldestRecentAgeMinutes).toBeGreaterThanOrEqual(29);
    expect(stuckRow!.oldestRecentAgeMinutes).toBeLessThanOrEqual(31);
    expect(stuckRow!.stuck).toBe(true);

    const healthyRow = byEvent.get(EVENT_HEALTHY);
    expect(healthyRow).toBeDefined();
    expect(healthyRow!.pendingTotal).toBe(1);
    expect(healthyRow!.pendingRecent).toBe(1);
    expect(healthyRow!.failedTotal).toBe(0);
    expect(healthyRow!.oldestRecentAgeMinutes).toBeLessThanOrEqual(3);
    expect(healthyRow!.stuck).toBe(false);

    const oldOnlyRow = byEvent.get(EVENT_OLD_ONLY);
    expect(oldOnlyRow).toBeDefined();
    expect(oldOnlyRow!.pendingTotal).toBe(1);
    expect(oldOnlyRow!.pendingRecent).toBe(0); // fora da janela de 6h
    expect(oldOnlyRow!.oldestRecentAgeMinutes).toBe(0); // nenhum pending "recente"
    expect(oldOnlyRow!.stuck).toBe(false);

    // Evento só com processed não deve poluir o relatório
    expect(byEvent.has(EVENT_ALL_PROCESSED)).toBe(false);
  });

  it('respects custom recentWindowHours/stuckThresholdMinutes', async () => {
    const service = new DomainEventBacklogService(pool);
    // Janela de 1h: EVENT_OLD_ONLY (8h) continua fora; threshold de 1min: EVENT_HEALTHY (2min) fica stuck
    const summary = await service.getBacklogSummary(1, 1);
    const byEvent = new Map(summary.map(row => [row.event, row]));

    const healthyRow = byEvent.get(EVENT_HEALTHY);
    expect(healthyRow).toBeDefined();
    expect(healthyRow!.stuck).toBe(true);

    const stuckRow = byEvent.get(EVENT_STUCK);
    expect(stuckRow).toBeDefined();
    expect(stuckRow!.pendingRecent).toBe(1); // 30min ainda dentro de janela 1h
  });
});
