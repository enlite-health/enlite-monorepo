/**
 * src/modules/anacare-hours/infrastructure/AnaCareProviderNameRepository.ts
 *
 * Resolve o NOME do prestador (worker) vinculado a um `ana_care_id`, em LOTE (1 query por
 * snapshot, nunca N+1 — mesmo padrão de `ShiftHoursValidationRepository.getByShiftIds`).
 *
 * Escopo travado (condições do lex, fix `fix/anacare-hours-vinculo-prestador`):
 * - Método NOVO e enxuto — NÃO reusa `WorkerRepository.findByIdWithPii` (que decripta sex/
 *   birth_date/document a mais). Só busca as 3 colunas necessárias para o nome.
 * - País travado em AR e `merged_into_id IS NULL` (worker absorvido em merge não resolve nome
 *   próprio — o `ana_care_id` migrou para o sobrevivente).
 * - O nome cifrado (`first_name_encrypted`/`last_name_encrypted`) é decriptado pelo
 *   `AnaCareHoursService` (KMS), não aqui — este repositório só lê do banco.
 */

import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface WorkerNameCiphertext {
  id: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

interface WorkerNameRow {
  ana_care_id: string;
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

export class AnaCareProviderNameRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * Busca em LOTE por `ana_care_id` (país AR, sem worker absorvido em merge) — devolve um Map
   * chaveado pelo `ana_care_id` de entrada, só com o suficiente para decriptar o nome.
   */
  async findByAnaCareIds(anaCareIds: readonly string[]): Promise<Map<string, WorkerNameCiphertext>> {
    if (anaCareIds.length === 0) return new Map();
    const res = await this.pool.query<WorkerNameRow>(
      `SELECT ana_care_id, id, first_name_encrypted, last_name_encrypted
         FROM workers
        WHERE ana_care_id = ANY($1::text[])
          AND country = 'AR'
          AND merged_into_id IS NULL`,
      [anaCareIds as string[]],
    );
    const out = new Map<string, WorkerNameCiphertext>();
    for (const row of res.rows) {
      out.set(row.ana_care_id, { id: row.id, firstNameEncrypted: row.first_name_encrypted, lastNameEncrypted: row.last_name_encrypted });
    }
    return out;
  }
}
