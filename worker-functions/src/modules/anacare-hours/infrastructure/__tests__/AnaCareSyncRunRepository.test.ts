/**
 * AnaCareSyncRunRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`),
 * mesmo molde de `AnaCareDirectorySnapshotRepository.test.ts`/`AnaCarePatientMonthRepository.test.ts`
 * deste módulo. Prova a FORMA do SQL (UPDATE por `(source, period_month)`, COALESCE nos 3 campos
 * que preservam valor anterior) e os parâmetros — não abre Postgres real (o gate não tem serviço
 * de banco, ver `anacareSyncRun457NoDefault.test.ts`). O comportamento do COALESCE em si foi
 * verificado manualmente contra Postgres 15 real (evidência colada na entrega desta fase).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { AnaCareSyncRunRepository } from '../AnaCareSyncRunRepository';
import type { SyncRunProgress } from '../../domain/AnaCareHoursSyncPorts';

describe('AnaCareSyncRunRepository', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  describe('recordProgress', () => {
    it('running: grava status/cursor/contagens, limpa finished_at/last_error', async () => {
      const repo = new AnaCareSyncRunRepository();
      const progress: SyncRunProgress = {
        status: 'running',
        cursor: 49,
        reservationsTotal: 144,
        reservationsDone: 49,
        finishedAt: null,
        lastError: null,
      };

      await repo.recordProgress('anacare', '2026-09', progress);

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE anacare_sync_run/);
      expect(sql).toMatch(/SET\s+status\s*=\s*\$1/);
      // "cursor" é palavra reservada — sempre entre aspas duplas no SQL, e sempre via COALESCE
      // (preserva o valor gravado quando o chamador manda null — caso da falha, testado abaixo).
      expect(sql).toMatch(/"cursor"\s*=\s*COALESCE\(\$2,\s*"cursor"\)/);
      expect(sql).toMatch(/reservations_total\s*=\s*COALESCE\(\$3,\s*reservations_total\)/);
      expect(sql).toMatch(/reservations_done\s*=\s*COALESCE\(\$4,\s*reservations_done\)/);
      expect(sql).toMatch(/finished_at\s*=\s*\$5/);
      expect(sql).toMatch(/last_error\s*=\s*\$6/);
      expect(sql).toMatch(/WHERE source = \$7 AND period_month = \$8::date/);
      expect(params).toEqual(['running', 49, 144, 49, null, null, 'anacare', '2026-09-01']);
    });

    it('done: finished_at explícito (não passa por COALESCE) e cursor/contagens finais', async () => {
      const repo = new AnaCareSyncRunRepository();
      const finishedAt = new Date('2026-09-20T12:00:00.000Z');

      await repo.recordProgress('anacare', '2026-09', {
        status: 'done',
        cursor: null,
        reservationsTotal: 144,
        reservationsDone: 144,
        finishedAt,
        lastError: null,
      });

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params).toEqual(['done', null, 144, 144, finishedAt, null, 'anacare', '2026-09-01']);
    });

    /**
     * PROVA do design.md §F1 ("cursor/contagens ficam com o último valor conhecido antes da
     * falha, não é sobrescrito para NULL"): o repositório recebe `null` nesses 3 campos e o SQL
     * gerado usa `COALESCE` — a forma do statement já garante que o Postgres preserva o valor
     * antigo em vez de zerar (comportamento de `COALESCE` verificado manualmente contra Postgres
     * real, fora do alcance do mock). Aqui provamos que o REPOSITÓRIO manda `null` (não um 0 nem
     * o valor "adivinhado") e usa a cláusula certa para preservar.
     */
    it('failed: cursor/reservationsTotal/reservationsDone nulos (COALESCE preserva), finished_at e last_error explícitos', async () => {
      const repo = new AnaCareSyncRunRepository();
      const finishedAt = new Date('2026-09-20T12:05:00.000Z');

      await repo.recordProgress('anacare', '2026-09', {
        status: 'failed',
        cursor: null,
        reservationsTotal: null,
        reservationsDone: null,
        finishedAt,
        lastError: 'AnaCarePatientMonthCollisionError:409',
      });

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/COALESCE\(\$2,\s*"cursor"\)/);
      expect(params).toEqual(['failed', null, null, null, finishedAt, 'AnaCarePatientMonthCollisionError:409', 'anacare', '2026-09-01']);
    });

    it('period_month vira o 1º dia do mês (mesmo molde de startNewRun/getRunStartedAt)', async () => {
      const repo = new AnaCareSyncRunRepository();
      await repo.recordProgress('anacare', '2026-01', {
        status: 'running',
        cursor: 0,
        reservationsTotal: 1,
        reservationsDone: 0,
        finishedAt: null,
        lastError: null,
      });
      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[7]).toBe('2026-01-01');
    });
  });
});
