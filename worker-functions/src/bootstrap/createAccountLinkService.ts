import type { Pool } from 'pg';
import { AccountLinkService } from '@modules/account-link/AccountLinkService';
import { createOtpChallengePort } from './createOtpChallengePort';

/** Monta o serviço do vínculo de contas com o port do OTP já escolhido (a camada de aplicação não importa o bootstrap). */
export function createAccountLinkService(pool: Pool): AccountLinkService {
  return new AccountLinkService(pool, { otp: createOtpChallengePort() });
}
