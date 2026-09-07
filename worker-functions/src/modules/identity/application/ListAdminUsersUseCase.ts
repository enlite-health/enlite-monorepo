import { Result } from '@shared/utils/Result';
import { AdminRepository } from '../infrastructure/AdminRepository';
import { toAdminUserDto, type AdminUserDto } from './adminUserDto';

export class ListAdminUsersUseCase {
  private adminRepo = new AdminRepository();

  async execute(limit = 50, offset = 0): Promise<Result<{ admins: AdminUserDto[]; total: number }>> {
    try {
      const data = await this.adminRepo.listAdmins(limit, offset);
      return Result.ok({ admins: data.admins.map(toAdminUserDto), total: data.total });
    } catch (error) {
      return Result.fail(
        error instanceof Error ? error.message : 'Failed to list admin users'
      );
    }
  }
}
