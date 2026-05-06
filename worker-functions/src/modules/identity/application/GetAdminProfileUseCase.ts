import { Result } from '@shared/utils/Result';
import { AdminRepository, AdminRecord } from '../infrastructure/AdminRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { EnliteRole } from '../domain/EnliteRole';
import * as admin from 'firebase-admin';

export class GetAdminProfileUseCase {
  private adminRepo = new AdminRepository();
  private db = DatabaseConnection.getInstance();

  async execute(firebaseUid: string): Promise<Result<any>> {
    try {
      let adminRecord = await this.adminRepo.findByFirebaseUid(firebaseUid);

      if (!adminRecord) {
        adminRecord = await this.autoProvisionIfEligible(firebaseUid);
        if (!adminRecord) {
          return Result.fail('Admin user not found');
        }
      }

      await this.adminRepo.updateLastLogin(firebaseUid);
      return Result.ok(adminRecord);
    } catch (error) {
      return Result.fail(
        error instanceof Error ? error.message : 'Failed to get admin profile'
      );
    }
  }

  /**
   * Auto-provisions an admin user for @enlite.health emails on first Google login.
   * Creates the user in the DB and sets Firebase custom claims.
   */
  private async autoProvisionIfEligible(firebaseUid: string): Promise<AdminRecord | null> {
    const firebaseUser = await admin.auth().getUser(firebaseUid);

    // Dev-only: claim seed rows by email when firebase_uid mismatches.
    // Why: local Docker uses prod Firebase Auth (docker-compose.prod-auth.yml) but a fresh
    // local DB seeded with placeholder firebase_uid. Without this, every `make reset` would
    // require re-promoting the seeded admin manually.
    if (process.env.NODE_ENV === 'development' && firebaseUser.email) {
      const seedRecord = await this.adminRepo.findByEmail(firebaseUser.email);
      if (seedRecord && seedRecord.firebaseUid !== firebaseUid) {
        await this.adminRepo.reassignFirebaseUid(firebaseUser.email, firebaseUid);
        return this.adminRepo.findByFirebaseUid(firebaseUid);
      }
    }

    if (!firebaseUser.email?.endsWith('@enlite.health')) {
      return null;
    }

    // Default role for new Enlite staff: RECRUITER.
    // Promotion to ADMIN must be done manually via the admin panel.
    const provisionedRole = EnliteRole.RECRUITER;

    await admin.auth().setCustomUserClaims(firebaseUid, { role: provisionedRole });

    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) as data',
        [
          firebaseUid,
          firebaseUser.email,
          firebaseUser.displayName || firebaseUser.email.split('@')[0],
          firebaseUser.photoURL || null,
          provisionedRole,
          JSON.stringify({ department: null }),
        ]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return this.adminRepo.findByFirebaseUid(firebaseUid);
  }
}
