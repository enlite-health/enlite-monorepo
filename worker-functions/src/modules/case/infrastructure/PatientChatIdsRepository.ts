import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientChatIdMap, PatientChatIdWriteMap } from '../domain/PatientChatId';
import { isExclusiveChatRole, type PatientChatRoleCatalog } from '../domain/PatientChatRole';

/** Nome + grupos atuais de um paciente, por papel. */
export interface PatientChatIdsRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  chatIds: PatientChatIdMap;
}

/** Um chat_id já preso a outro paciente, e em qual papel. */
export interface ChatIdConflict {
  chatId: string;
  patientId: string;
  role: string;
  /**
   * O papel em que ele está preso lá é exclusivo? Decide se o conflito barra.
   * Lido da coluna derivada `patient_chat_ids.is_exclusive`, que o catálogo
   * mantém em dia (PatientChatRolesRepository.update, na mesma transação).
   */
  exclusive: boolean;
}

/**
 * Uma linha do MAPA de três pontas: Postgres (`patientId`) ↔ ClickUp
 * (`clickupTaskId`) ↔ Periskope (os grupos, por papel).
 *
 * ⚠️ SÓ IDENTIFICADORES, por construção. Nome, telefone e documento do paciente
 * NUNCA entram aqui — quem consome é uma auditoria de contagem, que não precisa
 * saber quem é a pessoa (Regra de Classificação de Dados; Ley 25.326).
 */
export interface PatientChatMapRow {
  patientId: string;
  clickupTaskId: string | null;
  /** Papel -> chat_id. Só os papéis vinculados aparecem. */
  chatIds: PatientChatIdMap;
  /** Só na busca reversa (por chat_id): em qual papel o chat bateu. */
  matchedRole?: string;
}

/** Recorte do mapa. `linked` = tem pelo menos um grupo, em qualquer papel. */
export type ChatMapFilter = 'linked' | 'unlinked' | 'all';

/**
 * Agregação SQL dos grupos de um paciente em `{"FAMILY":"...@g.us", ...}`.
 * Reusada pelo mapa, pela reversa e pelo detalhe do paciente — uma escrita só,
 * para as três leituras não divergirem.
 */
export const PATIENT_CHAT_IDS_JSON_SUBQUERY = `
  COALESCE((SELECT jsonb_object_agg(c.role, c.chat_id)
              FROM patient_chat_ids c
             WHERE c.patient_id = p.id), '{}'::jsonb)`;

/**
 * PatientChatIdsRepository — leitura/escrita da tabela `patient_chat_ids`
 * (migration 261). Fatia estreita de propósito: a escrita tem regra própria
 * (unicidade por papel) e não passa pelo `updatePatientSection` genérico.
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
      `SELECT p.id,
              p.first_name AS "firstName",
              p.last_name  AS "lastName",
              ${PATIENT_CHAT_IDS_JSON_SUBQUERY} AS "chatIds"
         FROM patients p
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [patientId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Todos os grupos presos a pacientes DIFERENTES de `exceptPatientId`. Usado
   * para (a) marcar candidato já tomado na tela e (b) recusar a gravação antes
   * de bater na constraint, devolvendo 409 com a lista.
   *
   * Paciente soft-deleted fica de fora: o vínculo dele não deve segurar um grupo
   * que ninguém mais enxerga.
   */
  async findLinkedElsewhere(exceptPatientId: string): Promise<ChatIdConflict[]> {
    const res = await this.pool.query<ChatIdConflict>(
      `SELECT c.chat_id AS "chatId", c.patient_id AS "patientId", c.role,
              c.is_exclusive AS "exclusive"
         FROM patient_chat_ids c
         JOIN patients p ON p.id = c.patient_id
        WHERE c.patient_id <> $1
          AND p.deleted_at IS NULL`,
      [exceptPatientId],
    );
    return res.rows;
  }

  /**
   * MAPA EM MASSA — a ponte de três pontas para a auditoria de informes.
   *
   * Devolve `patient_id` + `clickup_task_id` + os grupos por papel de uma vez,
   * para a base inteira, em vez de obrigar quem consome a iterar paciente a
   * paciente. `deleted_at IS NULL` sempre. Ordenado por `id` para a paginação
   * ser estável.
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
        `SELECT p.id              AS "patientId",
                p.clickup_task_id AS "clickupTaskId",
                ${PATIENT_CHAT_IDS_JSON_SUBQUERY} AS "chatIds"
           FROM patients p
          WHERE p.deleted_at IS NULL AND ${where}
          ORDER BY p.id
          LIMIT $1 OFFSET $2`,
        [opts.limit, opts.offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM patients p WHERE p.deleted_at IS NULL AND ${where}`,
      ),
    ]);

    return { rows: rowsResult.rows, total: Number(totalResult.rows[0].total) };
  }

  /**
   * DIREÇÃO REVERSA — de qual paciente é este grupo, e em que papel?
   *
   * É a direção que a auditoria consome de fato: ela parte das conversas do
   * Periskope (que têm `chat_id`) e precisa saber a que paciente cada uma
   * pertence. O índice `idx_patient_chat_ids_chat_id` sustenta isso sem
   * varredura.
   *
   * Pode devolver MAIS DE UMA linha quando o papel não é exclusivo (ex.: se o
   * grupo do plano de saúde vier a ser compartilhado). Mentir sobre isso
   * esconderia justamente a contagem dupla que essa feature existe para evitar.
   */
  async findByChatId(chatId: string): Promise<PatientChatMapRow[]> {
    const result = await this.pool.query<PatientChatMapRow>(
      `SELECT p.id              AS "patientId",
              p.clickup_task_id AS "clickupTaskId",
              m.role            AS "matchedRole",
              ${PATIENT_CHAT_IDS_JSON_SUBQUERY} AS "chatIds"
         FROM patient_chat_ids m
         JOIN patients p ON p.id = m.patient_id
        WHERE m.chat_id = $1
          AND p.deleted_at IS NULL
        ORDER BY p.id, m.role`,
      [chatId],
    );
    return result.rows;
  }

  /**
   * Aplica o mapa de escrita, numa transação só.
   *
   * Semântica (documentada no domínio): `null` DESVINCULA, papel AUSENTE fica
   * inalterado. Não é PUT-substitui-tudo de propósito — assim uma versão antiga
   * do painel, que só conhece FAMILY e PROVIDERS, não apaga o HEALTH_PLAN que
   * ela nem sabe que existe.
   *
   * Devolve o estado final completo, para a resposta nunca ser um palpite do
   * que "provavelmente" ficou gravado.
   *
   * `catalog` entra por parâmetro em vez de ser lido aqui dentro: o serviço já
   * o carregou para validar os papéis, e ler duas vezes abriria uma janela em
   * que a validação e a gravação usariam políticas diferentes.
   */
  async applyChatIds(
    patientId: string,
    changes: PatientChatIdWriteMap,
    catalog: PatientChatRoleCatalog,
  ): Promise<PatientChatIdMap> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const [role, chatId] of Object.entries(changes)) {
        if (chatId === null) {
          await client.query('DELETE FROM patient_chat_ids WHERE patient_id = $1 AND role = $2', [
            patientId,
            role,
          ]);
          continue;
        }

        await client.query(
          `INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (patient_id, role)
           DO UPDATE SET chat_id      = EXCLUDED.chat_id,
                         is_exclusive = EXCLUDED.is_exclusive,
                         updated_at   = NOW()`,
          // A exclusividade sai do CATÁLOGO (ponto único). Esta coluna é só a
          // cópia que o índice parcial consegue enxergar.
          [patientId, role, chatId, isExclusiveChatRole(catalog, role)],
        );
      }

      // `updated_at` do paciente acompanha: a ficha mudou.
      await client.query('UPDATE patients SET updated_at = NOW() WHERE id = $1', [patientId]);

      const final = await client.query<{ role: string; chatId: string }>(
        'SELECT role, chat_id AS "chatId" FROM patient_chat_ids WHERE patient_id = $1',
        [patientId],
      );

      await client.query('COMMIT');
      return Object.fromEntries(final.rows.map(r => [r.role, r.chatId]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Recorte SQL do filtro do mapa. String literal fechada por união de tipos —
 * nada aqui vem do usuário, então não há superfície de injeção.
 */
function chatMapWhere(filter: ChatMapFilter): string {
  const HAS_ANY = 'EXISTS (SELECT 1 FROM patient_chat_ids c WHERE c.patient_id = p.id)';
  switch (filter) {
    case 'linked':
      return HAS_ANY;
    case 'unlinked':
      // A fila de trabalho do backfill: quem ainda não tem NENHUM grupo.
      return `NOT ${HAS_ANY}`;
    case 'all':
      return 'TRUE';
  }
}
