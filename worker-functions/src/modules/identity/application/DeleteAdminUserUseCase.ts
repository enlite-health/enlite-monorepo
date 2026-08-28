import { Result } from '@shared/utils/Result';
import { AdminRepository } from '../infrastructure/AdminRepository';
import { LAST_MANAGER_ERROR, isAntiLockoutError } from '../domain/lastManager';
import * as admin from 'firebase-admin';

export class DeleteAdminUserUseCase {
  private adminRepo = new AdminRepository();

  async execute(firebaseUid: string): Promise<Result<void>> {
    try {
      // 0. Anti-lockout (296): o último gestor não sai por aqui. Checado ANTES do
      //    Firebase porque a ordem abaixo apaga a conta lá primeiro — a recusa do
      //    trigger do banco, sozinha, deixaria a pessoa sem login e ainda no IAM.
      if (await this.adminRepo.isLastManager(firebaseUid)) {
        return Result.fail(LAST_MANAGER_ERROR);
      }

      // 1. Delete from Firebase
      await admin.auth().deleteUser(firebaseUid);

      // 2. Delete from DB — o trigger `trg_users_guard_last_manager` é a segunda tranca.
      await this.adminRepo.deleteByFirebaseUid(firebaseUid);

      return Result.ok();
    } catch (error) {
      if (isAntiLockoutError(error)) {
        return Result.fail(LAST_MANAGER_ERROR);
      }
      return Result.fail(
        error instanceof Error ? error.message : 'Failed to delete admin user'
      );
    }
  }
}
