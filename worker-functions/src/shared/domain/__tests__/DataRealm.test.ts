import { DataRealm } from '../DataRealm';

describe('DataRealm', () => {
  it('fromIsTest(true) → TEST', () => {
    expect(DataRealm.fromIsTest(true).equals(DataRealm.TEST)).toBe(true);
  });

  it('fromIsTest(false) → LIVE', () => {
    expect(DataRealm.fromIsTest(false).equals(DataRealm.LIVE)).toBe(true);
  });

  it('equals: LIVE não equivale a TEST', () => {
    expect(DataRealm.LIVE.equals(DataRealm.TEST)).toBe(false);
  });

  it('equals: TEST equivale a TEST', () => {
    expect(DataRealm.fromIsTest(true).equals(DataRealm.fromIsTest(true))).toBe(true);
  });

  it('round-trip: fromIsTest(x).toIsTest() === x', () => {
    expect(DataRealm.fromIsTest(true).toIsTest()).toBe(true);
    expect(DataRealm.fromIsTest(false).toIsTest()).toBe(false);
  });

  it('isTest getter reflete o realm', () => {
    expect(DataRealm.TEST.isTest).toBe(true);
    expect(DataRealm.LIVE.isTest).toBe(false);
  });

  it('toString retorna o nome canônico', () => {
    expect(DataRealm.LIVE.toString()).toBe('LIVE');
    expect(DataRealm.TEST.toString()).toBe('TEST');
  });
});
