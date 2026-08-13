import { DataRealm } from '@shared/domain/DataRealm';
import { SameRealmSpecification } from '../SameRealmSpecification';

describe('SameRealmSpecification', () => {
  it('LIVE → binda is_test=false no clause', () => {
    const spec = new SameRealmSpecification(DataRealm.LIVE);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.sql).toBe('w.is_test = $1::boolean');
    expect(clause.params).toEqual([false]);
  });

  it('TEST → binda is_test=true no clause', () => {
    const spec = new SameRealmSpecification(DataRealm.TEST);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.sql).toBe('w.is_test = $1::boolean');
    expect(clause.params).toEqual([true]);
  });

  it('respeita o paramOffset ao compor com outras specs', () => {
    const spec = new SameRealmSpecification(DataRealm.TEST);
    const clause = spec.toSqlClause({ paramOffset: 6 });

    expect(clause.sql).toBe('w.is_test = $7::boolean');
    expect(clause.params).toEqual([true]);
  });
});
