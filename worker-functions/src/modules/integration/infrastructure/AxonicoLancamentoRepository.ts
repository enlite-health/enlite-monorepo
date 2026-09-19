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
 * `status='enviado'` para a mesma tripla `(document_number, service_type, service_date)`, a
 * SEGUNDA chamada estoura por violação do índice único parcial `uq_axonico_lancamento_dedupe`
 * (migration 445). Isso é intencional: é essa violação que prova, em teste, que o dedupe local é
 * real — mascarar com `ON CONFLICT` esconderia justamente o que precisa ser provado.
 *
 * CORREÇÃO (18/09/2026, antes do merge): `findExisting`/`insert` chaveavam por `patient_id`.
 * Errado — o Axonico fatura pelo DNI (via `historia_clinica`), não pelo nosso `patient_id`, e dois
 * cadastros podem compartilhar o mesmo DNI (`patients.document_number` não tem UNIQUE). Agora o
 * WHERE de `findExisting` e a coluna de dedupe do `INSERT` usam `document_number` — `patient_id`
 * continua gravado (rastreabilidade), só sai da chave de busca/dedupe.
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
  document_number: string;
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
    documentNumber: row.document_number,
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
    documentNumber: string,
    serviceType: EnliteServiceType,
    serviceDate: string,
  ): Promise<AxonicoLancamentoRecord | null> {
    // `service_date::text` — o parser `postgres-date` do `pg` devolve `Date` em MEIA-NOITE LOCAL
    // para coluna `DATE` (comentário literal no fonte da lib: "Force YYYY-MM-DD dates to be
    // parsed as local time"). Sob TZ=Asia/Tokyo isso vira o dia ANTERIOR ao ler componentes UTC
    // (medido: 2026-09-18 gravado, `getUTCDate()` devolve 17). O cast tira o fuso do caminho —
    // o driver nunca chega a parsear a coluna como `Date`, e `serviceDate: string` do contrato é
    // verdade por construção, não um `as`.
    const res = await this.pool.query<AxonicoLancamentoRow>(
      `SELECT id, patient_id, document_number, service_type, service_date::text AS service_date, hours,
              numero_comprobante, cod_autorizacion, status, error_message, created_at
       FROM axonico_comprobante_lancamento
       WHERE document_number = $1 AND service_type = $2 AND service_date = $3::date AND status = 'enviado'`,
      [documentNumber, serviceType, serviceDate],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  /**
   * Nunca usa `ON CONFLICT` — uma segunda tentativa `status='enviado'` para a mesma tripla de
   * `document_number` PROPAGA a violação de `uq_axonico_lancamento_dedupe` para o chamador (F3
   * decide o que fazer — ver `AxonicoLancamentoConcorrenteError` no use case).
   */
  async insert(params: InsertAxonicoLancamentoParams): Promise<AxonicoLancamentoRecord> {
    // `service_date::text` no RETURNING — mesmo motivo do `findExisting` acima: sem o cast, o
    // `pg` devolveria `Date` (meia-noite LOCAL) em vez da string que o contrato promete.
    const res = await this.pool.query<AxonicoLancamentoRow>(
      `INSERT INTO axonico_comprobante_lancamento
         (patient_id, document_number, service_type, service_date, hours, numero_comprobante, cod_autorizacion, status, error_message)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9)
       RETURNING id, patient_id, document_number, service_type, service_date::text AS service_date, hours,
                 numero_comprobante, cod_autorizacion, status, error_message, created_at`,
      [
        params.patientId,
        params.documentNumber,
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
