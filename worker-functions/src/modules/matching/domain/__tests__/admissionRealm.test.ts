import { PAID_REHEARSAL_TTL_MS, admissionRealm, isBlockedFromPaidPath, transcriptDestination } from '../admissionRealm';

describe('admissionRealm (spec 050, R-18)', () => {
  it('paciente is_test → test, e test fica fora do caminho pago', () => {
    expect(admissionRealm({ isTest: true })).toBe('test');
    expect(isBlockedFromPaidPath('test')).toBe(true);
  });

  it('paciente real → real, que segue o caminho pago', () => {
    expect(admissionRealm({ isTest: false })).toBe('real');
    expect(isBlockedFromPaidPath('real')).toBe(false);
  });

  it('ensaio (liberação por reunião, fase seguinte) não é barrado', () => {
    expect(isBlockedFromPaidPath('ensaio')).toBe(false);
  });

  describe('ensaio pago (spec 050 F3, R-19)', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const em = (ms: number): Date => new Date(now.getTime() + ms);

    it('paciente de teste com liberação VIGENTE → ensaio', () => {
      expect(admissionRealm({ isTest: true, rehearsalUntil: em(1), now })).toBe('ensaio');
      expect(admissionRealm({ isTest: true, rehearsalUntil: em(PAID_REHEARSAL_TTL_MS), now })).toBe('ensaio');
    });

    it('liberação EXPIRADA (no instante exato ou depois), ausente ou nula → volta a test', () => {
      expect(admissionRealm({ isTest: true, rehearsalUntil: em(0), now })).toBe('test');
      expect(admissionRealm({ isTest: true, rehearsalUntil: em(-1), now })).toBe('test');
      expect(admissionRealm({ isTest: true, rehearsalUntil: null, now })).toBe('test');
      expect(admissionRealm({ isTest: true, now })).toBe('test');
    });

    it('paciente REAL nunca vira ensaio, mesmo com um registro de liberação', () => {
      expect(admissionRealm({ isTest: false, rehearsalUntil: em(PAID_REHEARSAL_TTL_MS), now })).toBe('real');
    });

    it('o prazo é de 48 h', () => {
      expect(PAID_REHEARSAL_TTL_MS).toBe(48 * 60 * 60 * 1000);
    });

    it('destino da transcrição (R-29): real → cofre, ensaio → bucket de ensaio, test → nenhum (nunca o contrário)', () => {
      expect(transcriptDestination('real')).toBe('vault');
      expect(transcriptDestination('ensaio')).toBe('rehearsal');
      expect(transcriptDestination('test')).toBe('none');
    });
  });
});
