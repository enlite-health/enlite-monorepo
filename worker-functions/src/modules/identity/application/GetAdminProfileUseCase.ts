import { Result } from '@shared/utils/Result';
import { AdminRepository, AdminRecord } from '../infrastructure/AdminRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { EnliteRole } from '../domain/EnliteRole';
import * as admin from 'firebase-admin';
import { reportError } from '@shared/logging';

const LOG = '[ADMIN-AUTH]';

export class GetAdminProfileUseCase {
  private adminRepo = new AdminRepository();
  private db = DatabaseConnection.getInstance();

  async execute(firebaseUid: string): Promise<Result<any>> {
    console.log(`${LOG} getProfile start | uid=${firebaseUid}`);

    try {
      let adminRecord = await this.adminRepo.findByFirebaseUid(firebaseUid);

      if (adminRecord) {
        console.log(`${LOG} lookup hit | uid=${firebaseUid} email=${adminRecord.email} role=${adminRecord.role}`);
      } else {
        console.log(`${LOG} lookup miss | uid=${firebaseUid} — entering auto-provision`);
        adminRecord = await this.autoProvisionIfEligible(firebaseUid);
        if (!adminRecord) {
          console.log(`${LOG} auto-provision returned null | uid=${firebaseUid} — denying`);
          return Result.fail('Admin user not found');
        }
        console.log(`${LOG} auto-provision ok | uid=${firebaseUid} email=${adminRecord.email} role=${adminRecord.role}`);
      }

      await this.adminRepo.updateLastLogin(firebaseUid);
      return Result.ok(adminRecord);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to get admin profile';
      console.error(`${LOG} getProfile error | uid=${firebaseUid} | ${msg}`);
      return Result.fail(msg);
    }
  }

  /**
   * First-login flow for staff. Handles three cases:
   *  1. Email isn't @enlite.health → reject.
   *  2. A staff row with this email already exists under a different firebase_uid
   *     (typical when the user was invited via password reset and now signs in
   *     with Google, which mints a different uid) → reassign the firebase_uid
   *     to keep the original role/department, instead of creating a duplicate
   *     row that would hit the unique constraint on users.email.
   *  3. Brand-new @enlite.health user → provision with RECRUITER role.
   */
  private async autoProvisionIfEligible(firebaseUid: string): Promise<AdminRecord | null> {
    const firebaseUser = await admin.auth().getUser(firebaseUid);
    const email = firebaseUser.email;

    console.log(`${LOG} firebase user resolved | uid=${firebaseUid} email=${email ?? '(none)'} providers=${firebaseUser.providerData.map(p => p.providerId).join(',') || '(none)'}`);

    if (!email?.endsWith('@enlite.health')) {
      console.log(`${LOG} auto-provision rejected — email ${email ?? '(none)'} is not @enlite.health`);
      return null;
    }

    const existingByEmail = await this.adminRepo.findByEmail(email);
    if (existingByEmail && existingByEmail.firebaseUid !== firebaseUid) {
      console.log(`${LOG} reassigning firebase_uid for ${email} | old=${existingByEmail.firebaseUid} new=${firebaseUid} role=${existingByEmail.role}`);
      await this.adminRepo.reassignFirebaseUid(email, firebaseUid);
      const refreshed = await this.adminRepo.findByFirebaseUid(firebaseUid);
      console.log(`${LOG} reassign complete | uid=${firebaseUid} loaded=${refreshed ? 'yes' : 'no'}`);
      return refreshed;
    }

    const provisionedRole = EnliteRole.RECRUITER;
    console.log(`${LOG} provisioning new staff | uid=${firebaseUid} email=${email} role=${provisionedRole}`);

    await admin.auth().setCustomUserClaims(firebaseUid, { role: provisionedRole });

    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) as data',
        [
          firebaseUid,
          email,
          firebaseUser.displayName || email.split('@')[0],
          firebaseUser.photoURL || null,
          provisionedRole,
          JSON.stringify({ department: null }),
        ]
      );

      await client.query('COMMIT');
      console.log(`${LOG} provision committed | uid=${firebaseUid} email=${email}`);
    } catch (error) {
      await client.query('ROLLBACK').catch((err: unknown) => reportError(err instanceof Error ? err : new Error(String(err)), { source: 'GetAdminProfileUseCase:rollback' }));
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`${LOG} provision failed | uid=${firebaseUid} email=${email} | ${msg}`);
      throw error;
    } finally {
      client.release();
    }

    return this.adminRepo.findByFirebaseUid(firebaseUid);
  }
}
