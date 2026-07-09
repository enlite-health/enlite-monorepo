import { Result } from '@shared/utils/Result';
import { GoogleIdentityService } from '../infrastructure/GoogleIdentityService';
import { UserRepository } from '../infrastructure/UserRepository';

export interface DeleteUserDTO {
  authUid: string;
  userId?: string;
}

/**
 * Use case for complete user deletion
 * 
 * This performs a cascading delete:
 * 1. Deletes user from Google Identity Platform
 * 2. Deletes from users base table (cascades to all related tables)
 * 
 * HIPAA Compliance: No PII in logs or error messages
 */
export class DeleteUserUseCase {
  constructor(
    private userRepository: UserRepository,
    private googleIdentityService: GoogleIdentityService
  ) {}

  async execute(data: DeleteUserDTO): Promise<Result<void>> {
    try {
      // Step 1: Check if user exists in database
      const existsResult = await this.userRepository.existsByFirebaseUid(data.authUid);
      
      if (existsResult.isFailure) {
        return Result.fail<void>('Failed to verify user data');
      }

      const userExists = existsResult.getValue();

      // Step 2: Delete from Google Identity Platform
      const identityDeleteResult = await this.googleIdentityService.deleteUser(data.authUid);
      
      if (identityDeleteResult.isFailure) {
        // Log error without PII
        console.error('Failed to delete user from Identity Platform');
        return Result.fail<void>('Failed to delete user from authentication system');
      }

      // Step 3: Delete from database (users table cascades to workers_extension)
      if (userExists) {
        const deleteResult = await this.userRepository.deleteUserComplete(data.authUid);
        
        if (deleteResult.isFailure) {
          console.error('Failed to delete user record from database');
          return Result.fail<void>('Failed to delete user data');
        }
      }

      return Result.ok<void>();
    } catch (error: any) {
      // No PII in error messages
      console.error('Unexpected error during user deletion');
      return Result.fail<void>('Internal error during user deletion');
    }
  }
}
