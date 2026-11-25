import { WorkerRepository } from '@modules/worker/infrastructure/WorkerRepository';
import { createOtpChallengePort } from './createOtpChallengePort';
import { StartClaimUseCase } from '@modules/auth/application/StartClaimUseCase';
import { ConfirmClaimUseCase } from '@modules/auth/application/ConfirmClaimUseCase';
import { ClaimShellAbsorber } from '@modules/auth/application/ClaimShellAbsorber';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { ClaimController } from '@modules/auth/interfaces/controllers/ClaimController';

/**
 * Factory para o ClaimController e suas dependências.
 * Extraído de index.ts para manter o arquivo abaixo de 400 linhas.
 */
export function createClaimController(): ClaimController {
  const otp = createOtpChallengePort();
  const workerRepository = new WorkerRepository();
  return new ClaimController(
    new StartClaimUseCase(workerRepository, otp),
    new ConfirmClaimUseCase(workerRepository, otp, new ClaimShellAbsorber(DatabaseConnection.getInstance().getPool())),
  );
}
