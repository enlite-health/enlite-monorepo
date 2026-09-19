/**
 * PatientReadRepository — implementação de `IPatientReadPort` (F3, `integracao-axonico`).
 *
 * Mesmo padrão de `AxonicoLancamentoRepository`: `pg` puro, sem ORM, getter lazy memoizado para o
 * Pool (`DatabaseConnection.getInstance().getPool()`), sem receber Pool no construtor. Query
 * enxuta — só a coluna que o guard 0 do use case precisa, nunca a ficha inteira do paciente.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { IPatientReadPort, PatientDocumentNumber } from '../domain/IPatientReadPort';

interface PatientDocumentNumberRow {
  document_number: string | null;
}

export class PatientReadRepository implements IPatientReadPort {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async findDocumentNumber(patientId: string): Promise<PatientDocumentNumber | null> {
    const res = await this.pool.query<PatientDocumentNumberRow>(
      'SELECT document_number FROM patients WHERE id = $1',
      [patientId],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    return { documentNumber: row.document_number };
  }
}
