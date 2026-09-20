import { Result } from '@shared/utils/Result';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { AdminRepository } from '../infrastructure/AdminRepository';
import { EmailService } from '../infrastructure/EmailService';
import { EnliteRole, StaffRole } from '../domain/EnliteRole';
import { STAFF_ACCOUNT } from '../domain/AccountType';
import * as admin from 'firebase-admin';
import { mergeCustomClaims } from '../infrastructure/mergeCustomClaims';
import { reportError } from '@shared/logging';

export interface CreateAdminInput {
  email: string;
  displayName: string;
  department?: string;
}

/**
 * 07/09/2026 — o painel não escolhe mais papel: acesso se concede por grupo
 * (`/admin/access`), e uma conta nova nasce sem grupo (tela de boas-vindas
 * com o engine ligado). O papel gravado aqui é só o marcador de STAFF
 * (fronteira staff × prestador) e o fallback `untilEnforced` do intervalo
 * em que o `main` roda com o engine desligado — por isso o de MENOR
 * privilégio: `recruiter` é o mesmo que o auto-provisionamento do login
 * Google já dava (`GetAdminProfileUseCase`). Antes o default era `admin`.
 */
export const PAPEL_DE_CONTA_NOVA: StaffRole = EnliteRole.RECRUITER;

export class CreateAdminUserUseCase {
  private db = DatabaseConnection.getInstance();
  private adminRepo = new AdminRepository();
  private emailService = new EmailService();

  async execute(input: CreateAdminInput): Promise<Result<any>> {
    const role: StaffRole = PAPEL_DE_CONTA_NOVA;

    const client = await this.db.getPool().connect();
    let firebaseUser: admin.auth.UserRecord | null = null;
    let committed = false;

    try {
      // 1. Create Firebase user WITHOUT a password (invitation link flow)
      firebaseUser = await admin.auth().createUser({
        email: input.email,
        displayName: input.displayName,
      });

      // 2. Set custom claims — o tipo da conta é a fronteira (D294); o papel é a ponte/fallback.
      await mergeCustomClaims(firebaseUser.uid, { role, account_type: STAFF_ACCOUNT });

      // 3. Persist in DB inside a transaction
      await client.query('BEGIN');

      await client.query(
        'SELECT create_user_with_role($1, $2, $3, $4, $5, $6) AS data',
        [
          firebaseUser.uid,
          input.email,
          input.displayName,
          null, // photoUrl
          role,
          JSON.stringify({ department: input.department ?? null }),
        ]
      );

      await client.query('COMMIT');
      committed = true;

      // 4. Generate invitation / password-setup link (Firebase handles the link)
      const resetLink = await admin.auth().generatePasswordResetLink(input.email);

      // 5. Send invitation email (non-fatal)
      await this.emailService.sendInvitationEmail(
        input.email,
        input.displayName,
        resetLink
      ).catch((emailErr) => {
        console.error('Admin created but invitation email failed:', (emailErr as Error).message);
      });

      return Result.ok({
        firebaseUid: firebaseUser.uid,
        email: input.email,
        displayName: input.displayName,
        department: input.department ?? null,
        resetLink,
      });
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK').catch((err: unknown) => reportError(err instanceof Error ? err : new Error(String(err)), { source: 'CreateAdminUserUseCase:rollback' }));
        if (firebaseUser) {
          const uid = firebaseUser.uid;
          await admin.auth().deleteUser(uid).catch((err: unknown) => reportError(err instanceof Error ? err : new Error(String(err)), { source: 'CreateAdminUserUseCase:firebaseCleanup', userId: uid }));
        }
      }
      return Result.fail(
        error instanceof Error ? error.message : 'Failed to create admin user'
      );
    } finally {
      client.release();
    }
  }
}
