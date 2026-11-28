import type { OtpSendLedgerPort } from '../ports/OtpSendLedgerPort';
import { OTP_TTL_MINUTES } from '../ports/OtpChallengePort';

/**
 * Acha a ficha do desafio de claim pelo próprio requisitante (B4): o cliente não manda nem recebe o id interno da ficha.
 * `null` = o desafio não é deste uid, não é de claim ou já passou da validade do código.
 */
export class ResolveClaimTarget {
  constructor(private readonly ledger: Pick<OtpSendLedgerPort, 'findClaimTarget'>) {}

  execute(input: { challengeId: string; requesterUid: string }): Promise<string | null> {
    return this.ledger.findClaimTarget({ ...input, withinMinutes: OTP_TTL_MINUTES });
  }
}
