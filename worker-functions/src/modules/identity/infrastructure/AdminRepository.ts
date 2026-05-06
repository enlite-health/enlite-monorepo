import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

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

export class AdminRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Finds any staff member (admin | recruiter | community_manager) by Firebase UID.
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
        AND u.role IN ('admin', 'recruiter', 'community_manager')`,
      [uid]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Lists all staff members (admin | recruiter | community_manager) with pagination.
   */
  async listAdmins(limit = 50, offset = 0): Promise<{ admins: AdminRecord[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*) AS total FROM users
       WHERE role IN ('admin', 'recruiter', 'community_manager') AND is_active = true`
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
      WHERE u.role IN ('admin', 'recruiter', 'community_manager') AND u.is_active = true
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { admins: result.rows, total: parseInt(countResult.rows[0].total) };
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
   * Calls the change_user_role DB function to update role + department
   * and propagate to the correct extension table.
   */
  async updateRole(firebaseUid: string, newRole: string, roleData?: object): Promise<void> {
    await this.pool.query(
      `SELECT change_user_role($1, $2, $3::jsonb)`,
      [firebaseUid, newRole, JSON.stringify(roleData ?? {})]
    );
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
        AND u.role IN ('admin', 'recruiter', 'community_manager')
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
