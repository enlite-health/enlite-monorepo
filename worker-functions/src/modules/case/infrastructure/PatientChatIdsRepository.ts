import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientChatIds } from '../domain/PatientChatId';

/** Nome + chat IDs atuais de um paciente. */
export interface PatientChatIdsRow extends PatientChatIds {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

/** Um chat_id já preso a outro paciente, e em qual papel. */
export interface ChatIdConflict {
  chatId: string;
  patientId: string;
  role: 'family' | 'providers';
}

/**
 * PatientChatIdsRepository — leitura/escrita SÓ das duas colunas de chat_id do
 * paciente (migration 260). Fatia estreita de propósito: a escrita destes dois
 * campos tem regra própria (unicidade cruzada) e não passa pelo
 * `updatePatientSection` genérico.
 *
 * Nunca decripta PII: `first_name`/`last_name` de paciente são texto puro na
 * tabela (só responsáveis/profissionais são KMS).
 */
export class PatientChatIdsRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async findById(patientId: string): Promise<PatientChatIdsRow | null> {
    const res = await this.pool.query<PatientChatIdsRow>(
      `SELECT id,
              first_name        AS "firstName",
              last_name         AS "lastName",
              family_chat_id    AS "familyChatId",
              providers_chat_id AS "providersChatId"
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Todos os chat_ids (dos dois papéis) presos a pacientes DIFERENTES de
   * `exceptPatientId`. Usado para (a) marcar candidato já tomado na tela e
   * (b) recusar a gravação antes de bater na constraint.
   */
  async findLinkedElsewhere(exceptPatientId: string): Promise<ChatIdConflict[]> {
    const res = await this.pool.query<{ id: string; family: string | null; providers: string | null }>(
      `SELECT id, family_chat_id AS family, providers_chat_id AS providers
         FROM patients
        WHERE id <> $1
          AND deleted_at IS NULL
          AND (family_chat_id IS NOT NULL OR providers_chat_id IS NOT NULL)`,
      [exceptPatientId],
    );

    const conflicts: ChatIdConflict[] = [];
    for (const row of res.rows) {
      if (row.family) conflicts.push({ chatId: row.family, patientId: row.id, role: 'family' });
      if (row.providers) conflicts.push({ chatId: row.providers, patientId: row.id, role: 'providers' });
    }
    return conflicts;
  }

  /** Grava os dois campos. `null` limpa o vínculo. Retorna false se o paciente não existe. */
  async updateChatIds(patientId: string, chatIds: PatientChatIds): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE patients
          SET family_chat_id    = $2,
              providers_chat_id = $3,
              updated_at        = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId, chatIds.familyChatId, chatIds.providersChatId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
