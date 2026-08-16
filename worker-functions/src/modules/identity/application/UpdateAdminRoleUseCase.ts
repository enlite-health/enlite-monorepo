import { Result } from '@shared/utils/Result';
import { AdminRepository, AdminRecord } from '../infrastructure/AdminRepository';
import { isStaffRole } from '../domain/EnliteRole';
import { mergeCustomClaims } from '../infrastructure/mergeCustomClaims';

export interface UpdateAdminRoleInput {
  firebaseUid: string;
  newRole: string;
  department?: string;
}

export class UpdateAdminRoleUseCase {
  private adminRepo = new AdminRepository();

  async execute(input: UpdateAdminRoleInput): Promise<Result<AdminRecord>> {
    const { firebaseUid, newRole, department } = input;

    if (!isStaffRole(newRole)) {
      return Result.fail(`Invalid staff role: ${newRole}`);
    }

    const existing = await this.adminRepo.findByFirebaseUid(firebaseUid);
    if (!existing) {
      return Result.fail('User not found');
    }

    if (existing.role === newRole) {
      return Result.fail('User already has this role');
    }

    try {
      // Update DB first (calls change_user_role function)
      await this.adminRepo.updateRole(firebaseUid, newRole, { department });

      // Propagate new role to Firebase custom claims.
      // Skip in test environments (no Firebase project credentials available).
      if (process.env.NODE_ENV !== 'test') {
        await mergeCustomClaims(firebaseUid, { role: newRole });
      }

      // Return refreshed record
      const updated = await this.adminRepo.findByFirebaseUid(firebaseUid);
      return Result.ok(updated!);
    } catch (error) {
      return Result.fail(
        error instanceof Error ? error.message : 'Failed to update user role'
      );
    }
  }
}
