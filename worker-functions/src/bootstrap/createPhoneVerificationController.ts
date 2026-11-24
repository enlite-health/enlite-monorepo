import { WorkerRepository } from '@modules/worker/infrastructure/WorkerRepository';
import { PgPhoneVerificationRepository } from '@modules/worker/infrastructure/PgPhoneVerificationRepository';
import { StartPhoneVerificationUseCase } from '@modules/auth/application/StartPhoneVerificationUseCase';
import { ConfirmPhoneVerificationUseCase } from '@modules/auth/application/ConfirmPhoneVerificationUseCase';
import { ConfirmClaimUseCase } from '@modules/auth/application/ConfirmClaimUseCase';
import { ClaimShellAbsorber } from '@modules/auth/application/ClaimShellAbsorber';
import { PhoneVerificationController } from '@modules/auth/interfaces/controllers/PhoneVerificationController';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { createOtpChallengePort } from './createOtpChallengePort';

/** Fábrica do controller do celular verificado (fora do index.ts, que já passa do teto de linhas). */
export function createPhoneVerificationController(): PhoneVerificationController {
  const pool = DatabaseConnection.getInstance().getPool();
  const otp = createOtpChallengePort();
  const workers = new WorkerRepository();
  const verification = new PgPhoneVerificationRepository(pool);
  const claim = new ConfirmClaimUseCase(workers, otp, new ClaimShellAbsorber(pool));
  return new PhoneVerificationController(
    new StartPhoneVerificationUseCase(workers, verification, otp),
    new ConfirmPhoneVerificationUseCase(workers, verification, otp, claim, pool),
  );
}
