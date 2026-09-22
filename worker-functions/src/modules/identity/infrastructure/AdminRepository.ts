import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { escapeIlikeWildcards } from '@shared/utils/ilikeEscape';

export interface AdminRecord {
  firebaseUid: string;
  email: string;
  displayName: string | null;
  role: string;
  department: string | null;
  lastLoginAt: string | null;
  loginCount: number;
  createdAt: string;
}

/**
 * Linha do diretório de staff (spec 022, `contracts/openapi-staff-directory.md`;
 * `isOnline` — change 022-ux-mencao-e-notificacao, Rodada 2/R2-B).
 * De propósito, SÓ `uid`/`displayName`/`isOnline` — nunca `email` nem `role` (D-06: o
 * autocomplete de menção não precisa e o payload vaza menos).
 */
export interface StaffDirectoryEntry {
  uid: string;
  displayName: string | null;
  isOnline: boolean;
}

export class AdminRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Finds any staff member (`account_type = 'staff'`, D294) by Firebase UID.
   * All fields come from users (department, last_login_at, login_count since migration 134;
   * admins_extension removed in migration 135).
   */
  async findByFirebaseUid(uid: string): Promise<AdminRecord | null> {
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid      AS "firebaseUid",
        u.email,
        u.display_name      AS "displayName",
        u.role,
        u.department,
        u.last_login_at     AS "lastLoginAt",
        COALESCE(u.login_count, 0) AS "loginCount",
        u.created_at        AS "createdAt"
      FROM users u
      WHERE u.firebase_uid = $1
        AND u.account_type = 'staff'`,
      [uid]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Lists all staff members (`account_type = 'staff'`) with pagination.
   */
  async listAdmins(limit = 50, offset = 0): Promise<{ admins: AdminRecord[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*) AS total FROM users
       WHERE account_type = 'staff' AND is_active = true`
    );

    const result = await this.pool.query(
      `SELECT
        u.firebase_uid      AS "firebaseUid",
        u.email,
        u.display_name      AS "displayName",
        u.role,
        u.department,
        u.last_login_at     AS "lastLoginAt",
        COALESCE(u.login_count, 0) AS "loginCount",
        u.created_at        AS "createdAt"
      FROM users u
      WHERE u.account_type = 'staff' AND u.is_active = true
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { admins: result.rows, total: parseInt(countResult.rows[0].total) };
  }

  /**
   * Diretório de staff para o autocomplete de menção (`<@uid>`) do chat interno
   * (spec 022, T128). MESMO `WHERE` de "staff ativo" de `listAdmins` acima —
   * `account_type = 'staff' AND is_active = true` — para que inativo/prestador
   * nunca apareça na lista de menção. `ILIKE` em `display_name`/`email` (o
   * e-mail entra só como CRITÉRIO de busca — nunca sai na resposta), `LIMIT 20`.
   *
   * Achado do gate revisao-pr (Bloco 1): `%`/`_` são wildcards do ILIKE — sem escape,
   * `q='%'` (ou `q='%%'`) casava QUALQUER nome/e-mail e listava todo o staff. `escapeIlikeWildcards`
   * (molde: `IcdCatalogTerminology.buscar` / `AdminPatientsMapController`) neutraliza `\`, `%` e `_`
   * no VALOR; a cláusula fecha com `ESCAPE '\\'` — sem ela a barra que a função insere é lida como
   * caractere comum e o curinga volta a valer.
   * `ORDER BY u.display_name, u.firebase_uid` desempata nome repetido — sem isso, `LIMIT 20` corta
   * o mesmo conjunto de linhas empatadas em ordem instável entre chamadas (paginação/teste flaky).
   *
   * `q` AUSENTE/VAZIO (item 1 da change 022-ux-mencao-e-notificacao, revoga D-06): pula a
   * cláusula `ILIKE` inteira — não roda `ILIKE '%%'` (que casaria tudo do mesmo jeito, mas força o
   * planner a escanear via `ILIKE` em vez de poder usar um índice de igualdade/prefixo em
   * `display_name` se algum existir). Sem filtro nenhum, é só `ORDER BY ... LIMIT`, "os primeiros
   * N do diretório".
   */
  /**
   * `excludeUid` (R2-B, popup estilo ClickUp): o próprio requester nunca aparece na própria lista
   * de mencionáveis — `undefined`/`null` não exclui ninguém (uso interno/teste que não tem um
   * requester para excluir).
   *
   * `isOnline` (R2-B): calculado AQUI, no SQL, na leitura — nunca persistido
   * (`migrations/465_users_last_seen_at.sql`). Presença "simples": só o `last_seen_at` mais
   * recente importa, sem histórico.
   */
  async searchStaffDirectory(
    q: string | undefined,
    limit = 20,
    excludeUid?: string | null,
  ): Promise<StaffDirectoryEntry[]> {
    const trimmed = q?.trim();
    const exclude = excludeUid ?? null;
    if (!trimmed) {
      const result = await this.pool.query(
        `SELECT
          u.firebase_uid AS uid,
          u.display_name AS "displayName",
          (u.last_seen_at IS NOT NULL AND u.last_seen_at > now() - interval '5 minutes') AS "isOnline"
        FROM users u
        WHERE u.account_type = 'staff' AND u.is_active = true
          AND ($2::text IS NULL OR u.firebase_uid <> $2)
        ORDER BY u.display_name, u.firebase_uid
        LIMIT $1`,
        [limit, exclude]
      );
      return result.rows;
    }

    const escaped = escapeIlikeWildcards(trimmed);
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid AS uid,
        u.display_name AS "displayName",
        (u.last_seen_at IS NOT NULL AND u.last_seen_at > now() - interval '5 minutes') AS "isOnline"
      FROM users u
      WHERE u.account_type = 'staff' AND u.is_active = true
        AND (u.display_name ILIKE '%' || $1 || '%' ESCAPE '\\'
          OR u.email ILIKE '%' || $1 || '%' ESCAPE '\\')
        AND ($3::text IS NULL OR u.firebase_uid <> $3)
      ORDER BY u.display_name, u.firebase_uid
      LIMIT $2`,
      [escaped, limit, exclude]
    );
    return result.rows;
  }

  /**
   * Heartbeat de presença (R2-B, `POST /api/admin/me/presence`) — molde `updateLastLogin` (mesma
   * tabela, mesma forma: `UPDATE users SET <coluna> WHERE firebase_uid = $1`, sem
   * `withActorContext`/transação própria, porque não é ato auditável (sem histórico por decisão
   * do Gabriel, 22/09) nem depende de trigger que exija `app.current_uid`.
   *
   * Throttle NO SQL (WHERE), não na aplicação: `now() - interval '30 seconds'` na própria cláusula
   * torna a checagem e a escrita atômicas (sem round-trip de leitura antes) e barata — heartbeat
   * chamado a cada ~60s do cliente já não bateria o throttle na maioria das chamadas; a proteção
   * é para chamada em rajada (retry, múltiplas abas). Devolve se REGRAVOU (para teste/observabilidade
   * — o endpoint HTTP sempre responde 204 de qualquer forma, throttle é transparente ao cliente).
   */
  async touchPresence(firebaseUid: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE users
         SET last_seen_at = now()
       WHERE firebase_uid = $1
         AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds')`,
      [firebaseUid]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countAdmins(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS total FROM users WHERE role = 'admin'`
    );
    return parseInt(result.rows[0].total);
  }

  /** Updates last_login_at and login_count on users. */
  async updateLastLogin(firebaseUid: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET last_login_at = NOW(), login_count = login_count + 1
       WHERE firebase_uid = $1`,
      [firebaseUid]
    );
  }

  /**
   * O uid é o ÚNICO gestor vivo (`permission_management:write`) de algum tenant?
   * Fonte única: `iam.is_last_manager` (410) — a mesma função que o trigger de
   * `users` usa para recusar o DELETE. Aqui ela é PRÉ-checagem, porque o use case
   * apaga a conta no Firebase ANTES do banco: sem isto, a recusa do banco chegaria
   * com a conta Firebase já apagada.
   */
  async isLastManager(firebaseUid: string): Promise<boolean> {
    const result = await this.pool.query<{ last: boolean }>(
      `SELECT iam.is_last_manager($1) AS last`,
      [firebaseUid]
    );
    return result.rows[0]?.last === true;
  }

  async deleteByFirebaseUid(firebaseUid: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM users WHERE firebase_uid = $1`,
      [firebaseUid]
    );
  }

  async findByEmail(email: string): Promise<AdminRecord | null> {
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid      AS "firebaseUid",
        u.email,
        u.display_name      AS "displayName",
        u.role,
        u.department,
        u.last_login_at     AS "lastLoginAt",
        COALESCE(u.login_count, 0) AS "loginCount",
        u.created_at        AS "createdAt"
      FROM users u
      WHERE u.email = $1
        AND u.account_type = 'staff'
        AND u.is_active = true`,
      [email]
    );
    return result.rows[0] ?? null;
  }

  async reassignFirebaseUid(email: string, newFirebaseUid: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET firebase_uid = $1, updated_at = NOW()
       WHERE email = $2 AND firebase_uid <> $1`,
      [newFirebaseUid, email]
    );
  }
}
