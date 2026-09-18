/**
 * src/modules/integration/infrastructure/AxonicoLancamentoRepository.ts
 *
 * Acesso a `axonico_comprobante_lancamento` (migration 445, change `integracao-axonico` F2) —
 * registro de TENTATIVAS de lançamento de comprovante no Axonico. Mesmo padrão de
 * `AnaCareSyncRunRepository`: `pg` puro, sem ORM, getter lazy memoizado para o Pool
 * (`DatabaseConnection.getInstance().getPool()`), sem receber Pool no construtor.
 *
 * Diferença de desenho em relação a `AnaCareSyncRunRepository`: aqui NÃO existe `ON CONFLICT DO
 * UPDATE`. Cada tentativa é uma linha nova — se `insert` for chamado duas vezes com
 * `status='enviado'` para a mesma tripla `(patient_id, service_type, service_date)`, a SEGUNDA
 * chamada estoura por violação do índice único parcial `uq_axonico_lancamento_dedupe` (migration
 * 445). Isso é intencional: é essa violação que prova, em teste, que o dedupe local é real —
 * mascarar com `ON CONFLICT` esconderia justamente o que precisa ser provado.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { EnliteServiceType } from '../domain/EnliteServiceType';
import type {
  AxonicoLancamentoRecord,
  IAxonicoLancamentoRepository,
  InsertAxonicoLancamentoParams,
} from '../domain/IAxonicoLancamentoRepository';

interface AxonicoLancamentoRow {
  id: string;
  patient_id: string;
  service_type: string;
  service_date: string;
  hours: number;
  numero_comprobante: string | null;
  cod_autorizacion: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

function toRecord(row: AxonicoLancamentoRow): AxonicoLancamentoRecord {
  return {
    id: row.id,
    patientId: row.patient_id,
    serviceType: row.service_type as EnliteServiceType,
    serviceDate: row.service_date,
    hours: row.hours,
    numeroComprobante: row.numero_comprobante,
    codAutorizacion: row.cod_autorizacion,
    status: row.status as AxonicoLancamentoRecord['status'],
    errorMessage: row.error_message,
    createdAt: new Date(row.created_at),
  };
}

export class AxonicoLancamentoRepository implements IAxonicoLancamentoRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async findExisting(
    patientId: string,
    serviceType: EnliteServiceType,
    serviceDate: string,
  ): Promise<AxonicoLancamentoRecord | null> {
    const res = await this.pool.query<AxonicoLancamentoRow>(
      `SELECT id, patient_id, service_type, service_date, hours, numero_comprobante,
              cod_autorizacion, status, error_message, created_at
       FROM axonico_comprobante_lancamento
       WHERE patient_id = $1 AND service_type = $2 AND service_date = $3::date AND status = 'enviado'`,
      [patientId, serviceType, serviceDate],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  /**
   * Nunca usa `ON CONFLICT` — uma segunda tentativa `status='enviado'` para a mesma tripla
   * PROPAGA a violação de `uq_axonico_lancamento_dedupe` para o chamador (F3 decide o que fazer).
   */
  async insert(params: InsertAxonicoLancamentoParams): Promise<AxonicoLancamentoRecord> {
    const res = await this.pool.query<AxonicoLancamentoRow>(
      `INSERT INTO axonico_comprobante_lancamento
         (patient_id, service_type, service_date, hours, numero_comprobante, cod_autorizacion, status, error_message)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
       RETURNING id, patient_id, service_type, service_date, hours, numero_comprobante,
                 cod_autorizacion, status, error_message, created_at`,
      [
        params.patientId,
        params.serviceType,
        params.serviceDate,
        params.hours,
        params.numeroComprobante,
        params.codAutorizacion,
        params.status,
        params.errorMessage,
      ],
    );
    return toRecord(res.rows[0]);
  }
}
