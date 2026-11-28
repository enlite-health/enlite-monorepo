import { OTP_TTL_MINUTES } from '../OtpChallengePort';

describe('OtpChallengePort — validade do código (B11)', () => {
  it('OTP_TTL_MINUTES === 10: trocar exige trocar o Verify (10 min) e o handshake do app (WhatsAppOtpAutofill)', () => {
    expect(OTP_TTL_MINUTES).toBe(10);
  });
});
