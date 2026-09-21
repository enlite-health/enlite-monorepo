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
 * Linha do diretório de staff (spec 022, `contracts/openapi-staff-directory.md`).
 * De propósito, SÓ `uid`/`displayName` — nunca `email` nem `role` (D-06: o
 * autocomplete de menção não precisa e o payload vaza menos).
 */
export interface StaffDirectoryEntry {
  uid: string;
  displayName: string | null;
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
   */
  async searchStaffDirectory(q: string, limit = 20): Promise<StaffDirectoryEntry[]> {
    const escaped = escapeIlikeWildcards(q);
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid AS uid,
        u.display_name AS "displayName"
      FROM users u
      WHERE u.account_type = 'staff' AND u.is_active = true
        AND (u.display_name ILIKE '%' || $1 || '%' ESCAPE '\\'
          OR u.email ILIKE '%' || $1 || '%' ESCAPE '\\')
      ORDER BY u.display_name, u.firebase_uid
      LIMIT $2`,
      [escaped, limit]
    );
    return result.rows;
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
