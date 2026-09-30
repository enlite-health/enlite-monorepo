import type { Pool, PoolClient } from 'pg';

export interface ServiceExitReasonOption {
  code: string;
  label: string;
}

/** Leitura do catálogo de motivos de saída (migration 492) — uma query cada, sem cache. */
export class ServiceExitReasonReader {
  /** O motivo ativo com este `code`, ou `null` (inexistente ou inativo). */
  async findActiveByCode(cli: Pool | PoolClient, code: string): Promise<ServiceExitReasonOption | null> {
    const res = await cli.query<ServiceExitReasonOption>(
      'SELECT code, label FROM service_exit_reasons WHERE active AND code = $1',
      [code],
    );
    return res.rows[0] ?? null;
  }

  /** Só os ativos, por `sort_order` e depois rótulo. */
  async listActiveOptions(cli: Pool | PoolClient): Promise<ServiceExitReasonOption[]> {
    const res = await cli.query<ServiceExitReasonOption>(
      'SELECT code, label FROM service_exit_reasons WHERE active ORDER BY sort_order, lower(label)',
    );
    return res.rows;
  }
}
