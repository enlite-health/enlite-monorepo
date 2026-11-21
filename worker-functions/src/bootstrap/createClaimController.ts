import { WorkerRepository } from '@modules/worker/infrastructure/WorkerRepository';
import { TwilioVerifyService } from '@modules/auth/infrastructure/TwilioVerifyService';
import { IsTestOtpGuardedVerify } from '@modules/auth/application/IsTestOtpGuard';
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
  const twilioVerify = new IsTestOtpGuardedVerify(new TwilioVerifyService());
  const workerRepository = new WorkerRepository();
  return new ClaimController(
    new StartClaimUseCase(workerRepository, twilioVerify),
    new ConfirmClaimUseCase(workerRepository, twilioVerify, new ClaimShellAbsorber(DatabaseConnection.getInstance().getPool())),
  );
}
