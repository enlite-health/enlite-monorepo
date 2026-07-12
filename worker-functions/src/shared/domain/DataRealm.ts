export type DataRealmName = 'LIVE' | 'TEST';

export class DataRealm {
  private constructor(private readonly name: DataRealmName) {}

  static readonly LIVE = new DataRealm('LIVE');
  static readonly TEST = new DataRealm('TEST');

  static fromIsTest(isTest: boolean): DataRealm {
    return isTest ? DataRealm.TEST : DataRealm.LIVE;
  }

  get isTest(): boolean {
    return this.name === 'TEST';
  }

  toIsTest(): boolean {
    return this.isTest;
  }

  equals(other: DataRealm): boolean {
    return this.name === other.name;
  }

  toString(): DataRealmName {
    return this.name;
  }
}
