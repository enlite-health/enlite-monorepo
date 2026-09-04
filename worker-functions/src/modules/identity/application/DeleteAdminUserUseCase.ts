import { Result } from '@shared/utils/Result';
import { AdminRepository } from '../infrastructure/AdminRepository';
import { isPermissionError, toPermissionError, type PermissionErrorCode } from '@modules/identity/permissions';
import * as admin from 'firebase-admin';

/** O único código de domínio que este use case emite — o mesmo do painel (409). */
export const LAST_MANAGER: PermissionErrorCode = 'last_manager';

export class DeleteAdminUserUseCase {
  private adminRepo = new AdminRepository();

  async execute(firebaseUid: string): Promise<Result<void>> {
    try {
      // 0. Anti-lockout (410): o último gestor não sai por aqui. Checado ANTES do
      //    Firebase porque a ordem abaixo apaga a conta lá primeiro — a recusa do
      //    trigger do banco, sozinha, deixaria a pessoa sem login e ainda no IAM.
      //    (A janela entre este check e o trigger continua existindo — decisão
      //    de inverter a ordem Firebase→banco fica registrada, não tomada aqui.)
      if (await this.adminRepo.isLastManager(firebaseUid)) {
        return Result.fail(LAST_MANAGER);
      }

      // 1. Delete from Firebase
      await admin.auth().deleteUser(firebaseUid);

      // 2. Delete from DB — o trigger `trg_users_guard_last_manager` é a segunda tranca.
      await this.adminRepo.deleteByFirebaseUid(firebaseUid);

      return Result.ok();
    } catch (error) {
      // `toPermissionError` é quem sabe ler o 23514/anti-lockout do banco — o
      // mesmo tradutor do painel, não uma segunda cópia do predicado.
      const perm = toPermissionError(error);
      if (isPermissionError(perm) && perm.code === LAST_MANAGER) {
        return Result.fail(LAST_MANAGER);
      }
      return Result.fail(
        error instanceof Error ? error.message : 'Failed to delete admin user'
      );
    }
  }
}
