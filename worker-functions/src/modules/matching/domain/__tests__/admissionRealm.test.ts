import { admissionRealm, isBlockedFromPaidPath } from '../admissionRealm';

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
});
