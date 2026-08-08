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
 * Uma linha do MAPA de três pontas: Postgres (`patientId`) ↔ ClickUp
 * (`clickupTaskId`) ↔ Periskope (os dois `*ChatId`).
 *
 * ⚠️ SÓ IDENTIFICADORES, por construção. Nome, telefone e documento do paciente
 * NUNCA entram aqui — quem consome é uma auditoria de contagem, que não precisa
 * saber quem é a pessoa (Regra de Classificação de Dados; Ley 25.326).
 */
export interface PatientChatMapRow {
  patientId: string;
  clickupTaskId: string | null;
  familyChatId: string | null;
  providersChatId: string | null;
  /** Só na busca reversa (por chat_id): em qual papel o chat bateu. */
  matchedRole?: 'family' | 'providers';
}

/** Recorte do mapa. `linked` = tem pelo menos um dos dois grupos. */
export type ChatMapFilter = 'linked' | 'unlinked' | 'all';

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

  /**
   * MAPA EM MASSA — a ponte de três pontas para a auditoria de informes.
   *
   * Devolve `patient_id` + `clickup_task_id` + os dois chat IDs de uma vez, para
   * a base inteira, em vez de obrigar quem consome a iterar paciente a paciente.
   * `deleted_at IS NULL` sempre. Ordenado por `id` para a paginação ser estável.
   *
   * Nenhuma coluna de PII entra no SELECT — a garantia é a lista de colunas
   * abaixo, não a boa vontade de quem chama.
   */
  async findChatMap(opts: {
    filter: ChatMapFilter;
    limit: number;
    offset: number;
  }): Promise<{ rows: PatientChatMapRow[]; total: number }> {
    const where = chatMapWhere(opts.filter);

    const [rowsResult, totalResult] = await Promise.all([
      this.pool.query<PatientChatMapRow>(
        `SELECT id                AS "patientId",
                clickup_task_id   AS "clickupTaskId",
                family_chat_id    AS "familyChatId",
                providers_chat_id AS "providersChatId"
           FROM patients
          WHERE deleted_at IS NULL AND ${where}
          ORDER BY id
          LIMIT $1 OFFSET $2`,
        [opts.limit, opts.offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM patients WHERE deleted_at IS NULL AND ${where}`,
      ),
    ]);

    return { rows: rowsResult.rows, total: Number(totalResult.rows[0].total) };
  }

  /**
   * DIREÇÃO REVERSA — de qual paciente é este grupo?
   *
   * É a direção que a auditoria consome de fato: ela parte das conversas do
   * Periskope (que têm `chat_id`) e precisa saber a que paciente cada uma
   * pertence. Os índices únicos parciais da migration 260
   * (`idx_patients_family_chat_id_unique` / `..._providers_...`) sustentam isso
   * sem varredura — e garantem no máximo uma linha por coluna.
   *
   * Devolve no máximo um resultado por papel; se o mesmo chat_id estiver nos
   * dois papéis de pacientes diferentes (colisão cruzada, que índice não cobre),
   * os dois aparecem — mentir sobre isso esconderia justamente a contagem dupla
   * que essa feature existe para evitar.
   */
  async findByChatId(chatId: string): Promise<PatientChatMapRow[]> {
    const result = await this.pool.query<PatientChatMapRow>(
      `SELECT id                AS "patientId",
              clickup_task_id   AS "clickupTaskId",
              family_chat_id    AS "familyChatId",
              providers_chat_id AS "providersChatId",
              CASE WHEN family_chat_id = $1 THEN 'family' ELSE 'providers' END AS "matchedRole"
         FROM patients
        WHERE deleted_at IS NULL
          AND (family_chat_id = $1 OR providers_chat_id = $1)
        ORDER BY id`,
      [chatId],
    );
    return result.rows;
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

/**
 * Recorte SQL do filtro do mapa. String literal fechada por união de tipos —
 * nada aqui vem do usuário, então não há superfície de injeção.
 */
function chatMapWhere(filter: ChatMapFilter): string {
  switch (filter) {
    case 'linked':
      return '(family_chat_id IS NOT NULL OR providers_chat_id IS NOT NULL)';
    case 'unlinked':
      // A fila de trabalho do backfill: quem ainda não tem NENHUM dos dois.
      return '(family_chat_id IS NULL AND providers_chat_id IS NULL)';
    case 'all':
      return 'TRUE';
  }
}
