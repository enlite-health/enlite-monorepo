import { Result } from '@shared/utils/Result';
import { GoogleIdentityService } from '../infrastructure/GoogleIdentityService';
import { UserRepository } from '../infrastructure/UserRepository';
import { PgLoginRemovalRepository } from '../infrastructure/PgLoginRemovalRepository';
import type { AccountLoginRemoval } from './AccountLoginRemoval';

export interface DeleteUserByEmailDTO {
  email: string;
  /** uid de quem pede (vai para revoked_by); ausente → a própria conta. */
  actorUid?: string;
}

/**
 * Admin use case for complete user deletion by email
 * 
 * This performs a cascading delete:
 * 1. Finds user by email in database
 * 2. Deletes user from Google Identity Platform by email
 * 3. Deletes from users base table (cascades to all related tables)
 * 
 * HIPAA Compliance: No PII in logs or error messages
 * Security: This should only be accessible by admins
 */
export class DeleteUserByEmailUseCase {
  constructor(
    private userRepository: UserRepository,
    private googleIdentityService: GoogleIdentityService,
    private loginRemoval: AccountLoginRemoval = new PgLoginRemovalRepository()
  ) {}

  async execute(data: DeleteUserByEmailDTO): Promise<Result<void>> {
    try {
      // Step 1: Find user by email to get firebase_uid
      const userResult = await this.userRepository.findByEmail(data.email);
      
      if (userResult.isFailure) {
        return Result.fail<void>('Failed to find user');
      }

      const user = userResult.getValue();
      
      if (!user) {
        return Result.fail<void>('User not found');
      }

      const firebaseUid = user.firebase_uid;

      // Step 2: Delete from Google Identity Platform by email
      const identityDeleteResult = await this.googleIdentityService.deleteUserByEmail(data.email);
      
      if (identityDeleteResult.isFailure) {
        console.error('Failed to delete user from Identity Platform');
        // Continue with database deletion even if Identity Platform deletion fails
      } else {
        // Conta apagada no Firebase → o login sai do iam (DF-20). Só no sucesso: conta viva não perde o login.
        try {
          await this.loginRemoval.markDeleted(firebaseUid, data.actorUid ?? firebaseUid);
        } catch {
          console.error('Failed to mark login as removed in iam');
          return Result.fail<void>('Failed to record account removal');
        }
      }

      // Step 3: Delete from database (users table cascades to all extension tables)
      const deleteResult = await this.userRepository.deleteUserComplete(firebaseUid);
      
      if (deleteResult.isFailure) {
        console.error('Failed to delete user record from database');
        return Result.fail<void>('Failed to delete user data');
      }

      return Result.ok<void>();
    } catch (error: unknown) {
      console.error('Unexpected error during user deletion by email');
      return Result.fail<void>('Internal error during user deletion');
    }
  }
}
