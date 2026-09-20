/**
 * src/modules/integration/infrastructure/AnaCarePatientDocumentRepository.ts
 *
 * Acesso a `ana_care_patient_document` (migration 446) — documento (DNI) de paciente do Ana Care
 * informado manualmente pelo operador. Mesmo padrão de `AxonicoLancamentoRepository`: `pg` puro,
 * sem ORM, getter lazy memoizado para o Pool (`DatabaseConnection.getInstance().getPool()`), sem
 * receber Pool no construtor.
 *
 * `insert` NUNCA faz `ON CONFLICT DO UPDATE` — o use case lê com `findByPatientId` antes e decide
 * 200 idempotente ou 409 conforme o número já registrado; uma corrida concorrente para o MESMO
 * `ana_care_patient_id` estoura por violação de `uq_ana_care_patient_document_patient` (23505),
 * propagada ao chamador.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type {
  AnaCarePatientDocumentRecord,
  IAnaCarePatientDocumentRepository,
  InsertAnaCarePatientDocumentParams,
} from '../domain/IAnaCarePatientDocumentRepository';

interface AnaCarePatientDocumentRow {
  id: string;
  ana_care_patient_id: string;
  document_number: string;
  document_type: string | null;
  registered_by: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: AnaCarePatientDocumentRow): AnaCarePatientDocumentRecord {
  return {
    id: row.id,
    anaCarePatientId: row.ana_care_patient_id,
    documentNumber: row.document_number,
    documentType: row.document_type,
    registeredBy: row.registered_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class AnaCarePatientDocumentRepository implements IAnaCarePatientDocumentRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async findByPatientId(anaCarePatientId: string): Promise<AnaCarePatientDocumentRecord | null> {
    const res = await this.pool.query<AnaCarePatientDocumentRow>(
      `SELECT id, ana_care_patient_id, document_number, document_type, registered_by, created_at, updated_at
       FROM ana_care_patient_document
       WHERE ana_care_patient_id = $1`,
      [anaCarePatientId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async insert(params: InsertAnaCarePatientDocumentParams): Promise<AnaCarePatientDocumentRecord> {
    const res = await this.pool.query<AnaCarePatientDocumentRow>(
      `INSERT INTO ana_care_patient_document
         (ana_care_patient_id, document_number, document_type, registered_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, ana_care_patient_id, document_number, document_type, registered_by, created_at, updated_at`,
      [params.anaCarePatientId, params.documentNumber, params.documentType, params.registeredBy],
    );
    return toRecord(res.rows[0]);
  }
}
