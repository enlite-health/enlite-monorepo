import { GuardedOtpChallengePort } from '../GuardedOtpChallengePort';
import type { OtpChallengePort, OtpStartInput } from '../../ports/OtpChallengePort';
import type { OtpSendLedgerPort } from '../../ports/OtpSendLedgerPort';

const mockWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: { child: () => ({ warn: (...a: unknown[]) => mockWarn(...a) }) },
  safeErrorFields: () => ({ errorName: 'Error' }),
}));

const MAX = 99;
const base: OtpStartInput = {
  workerId: 'worker-1',
  purpose: 'claim',
  phoneE164: '+5491100000000',
  requesterUid: 'uid-teste-1',
};

function montar(adapter: 'own' | 'verify' = 'own', sent = 0) {
  const inner = {
    start: jest.fn().mockResolvedValue({ challengeId: 'ch-1' }),
    check: jest.fn().mockResolvedValue({ ok: true }),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const ledger = { sentToday: jest.fn().mockResolvedValue(sent), record: jest.fn().mockResolvedValue(undefined) };
  const port = new GuardedOtpChallengePort(inner as unknown as OtpChallengePort, ledger as unknown as OtpSendLedgerPort, adapter, MAX);
  return { inner, ledger, port };
}

beforeEach(() => mockWarn.mockClear());

describe('GuardedOtpChallengePort', () => {
  it('(1) teto batido: lança OTP_CHANNEL_UNAVAILABLE, não envia, loga sent e dailyMax sem telefone', async () => {
    const { inner, port } = montar('own', MAX);
    await expect(port.start(base)).rejects.toThrow('OTP_CHANNEL_UNAVAILABLE');
    expect(inner.start).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith({ msg: 'otp_global_ceiling_reached', sent: MAX, dailyMax: MAX });
    expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/5491100000000|phoneE164/);
  });

  it('(2) abaixo do teto: delega e grava 1 evento', async () => {
    const { inner, ledger, port } = montar('own', MAX - 1);
    await expect(port.start(base)).resolves.toEqual({ challengeId: 'ch-1' });
    expect(inner.start).toHaveBeenCalledWith(base);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith({
      challengeId: 'ch-1', adapter: 'own', purpose: 'claim', requesterUid: 'uid-teste-1', targetWorkerId: null, suppressed: false,
    });
  });

  it('(3) suprimido (ficha is_test + e-mail @enlite.test) com teto batido: delega e grava suppressed true', async () => {
    const { inner, ledger, port } = montar('own', MAX);
    const ctx = { workerId: 'worker-1', fichaIsTest: true, tokenEmail: 'qa.teste@enlite.test' };
    await expect(port.start({ ...base, ctx })).resolves.toEqual({ challengeId: 'ch-1' });
    expect(ledger.sentToday).not.toHaveBeenCalled();
    expect(inner.start).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ suppressed: true }));
  });

  it('(4) destino fora de AR/BR: lança PHONE_COUNTRY_NOT_SUPPORTED e nada é contado nem enviado', async () => {
    const { inner, ledger, port } = montar();
    await expect(port.start({ ...base, phoneE164: '+12025550123' })).rejects.toThrow('PHONE_COUNTRY_NOT_SUPPORTED');
    expect(ledger.sentToday).not.toHaveBeenCalled();
    expect(inner.start).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('(5) record falha: devolve o challengeId mesmo assim e loga sem telefone', async () => {
    const { ledger, port } = montar();
    ledger.record.mockRejectedValue(new Error('db fora +5491100000000'));
    await expect(port.start(base)).resolves.toEqual({ challengeId: 'ch-1' });
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'otp_send_event_record_failed' }));
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('5491100000000');
  });

  it('(6) adapter own grava targetWorkerId null; verify grava o workerId', async () => {
    const own = montar('own');
    await own.port.start(base);
    expect(own.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'own', targetWorkerId: null }));
    const verify = montar('verify');
    await verify.port.start(base);
    expect(verify.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'verify', targetWorkerId: 'worker-1' }));
  });

  it('check e cancel delegam ao adapter', async () => {
    const { inner, port } = montar();
    const chk = { challengeId: 'c', workerId: 'w', purpose: 'link' as const, phoneOnRecord: '+5491100000000', code: '123456' };
    await port.check(chk);
    await port.cancel({ workerId: 'w', purpose: 'link' });
    expect(inner.check).toHaveBeenCalledWith(chk);
    expect(inner.cancel).toHaveBeenCalledWith({ workerId: 'w', purpose: 'link' });
  });
});
