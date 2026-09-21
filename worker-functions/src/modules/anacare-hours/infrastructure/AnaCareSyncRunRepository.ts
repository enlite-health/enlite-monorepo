/**
 * src/modules/anacare-hours/infrastructure/AnaCareSyncRunRepository.ts
 *
 * Acesso a `anacare_sync_run` (migration 443, gate `revisao-pr` fecho 17/09) — o carimbo do início
 * da corrida de sync, gravado com `NOW()` DO BANCO. Substitui o desenho anterior em que
 * `runStartedAt` chegava no corpo HTTP (`syncTriggerBodySchema`, vindo do cliente): o Cloud
 * Scheduler nunca lia a resposta para reenviar o carimbo na retomada, uma data no futuro desligava
 * o detector de colisão inteiro, e comparar contra um `Date` calculado no Node sofria deriva de
 * relógio entre processos. Ver cabeçalho da migration para os 3 buracos medidos.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { SyncRunProgress, SyncRunRepository } from '../domain/AnaCareHoursSyncPorts';

/** `period_month` da tabela é sempre o 1º dia do mês (CHECK, migration 443) — mesmo molde de `AnaCarePatientMonthRepository`. */
function periodMonthDate(month: string): string {
  return `${month}-01`;
}

export class AnaCareSyncRunRepository implements SyncRunRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Corrida NOVA: `NOW()` do banco, nunca um `Date` calculado no Node — ver contrato na porta. */
  async startNewRun(source: string, periodMonth: string): Promise<Date> {
    const res = await this.pool.query<{ run_started_at: string }>(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at)
       VALUES ($1, $2::date, NOW(), NOW())
       ON CONFLICT (source, period_month) DO UPDATE SET
         run_started_at = EXCLUDED.run_started_at,
         updated_at      = NOW()
       RETURNING run_started_at`,
      [source, periodMonthDate(periodMonth)],
    );
    return new Date(res.rows[0].run_started_at);
  }

  /** Retomada: lê o carimbo já gravado. `null` = nenhuma corrida registrada para este mês. */
  async getRunStartedAt(source: string, periodMonth: string): Promise<Date | null> {
    const res = await this.pool.query<{ run_started_at: string }>(
      `SELECT run_started_at FROM anacare_sync_run WHERE source = $1 AND period_month = $2::date`,
      [source, periodMonthDate(periodMonth)],
    );
    return res.rows[0] ? new Date(res.rows[0].run_started_at) : null;
  }

  /**
   * F1 (migration 457): grava o progresso da rodada. `"cursor"`/`reservations_total`/
   * `reservations_done` usam `COALESCE` — passar `null` nesses três PRESERVA o valor já gravado
   * (nunca sobrescreve para `NULL`); é assim que uma falha grava `status='failed'` sem apagar o
   * último cursor/contagem conhecidos (ver `SyncRunProgress`, `AnaCareHoursSyncPorts.ts`).
   * `finished_at`/`last_error` são SEMPRE explícitos: o chamador sempre sabe o valor certo (`null`
   * limpa, um valor grava), então nunca passam por `COALESCE`. `"cursor"` é palavra RESERVADA em
   * SQL — sempre entre aspas duplas.
   */
  async recordProgress(source: string, periodMonth: string, progress: SyncRunProgress): Promise<void> {
    await this.pool.query(
      `UPDATE anacare_sync_run
          SET status              = $1,
              "cursor"            = COALESCE($2, "cursor"),
              reservations_total  = COALESCE($3, reservations_total),
              reservations_done   = COALESCE($4, reservations_done),
              finished_at         = $5,
              last_error          = $6,
              updated_at          = NOW()
        WHERE source = $7 AND period_month = $8::date`,
      [
        progress.status,
        progress.cursor,
        progress.reservationsTotal,
        progress.reservationsDone,
        progress.finishedAt,
        progress.lastError,
        source,
        periodMonthDate(periodMonth),
      ],
    );
  }
}
