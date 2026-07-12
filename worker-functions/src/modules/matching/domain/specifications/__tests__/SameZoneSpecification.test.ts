import { SameZoneSpecification } from '../SameZoneSpecification';

describe('SameZoneSpecification', () => {
  it('sem raio (radiusKm null) → applyGeo=false, coords zeradas', () => {
    const spec = new SameZoneSpecification(null, -34.6, -58.4);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.params).toEqual([false, 0, 0, 0]);
  });

  it('com raio e coords da vaga → applyGeo=true, lng/lat/raio bindados', () => {
    const spec = new SameZoneSpecification(30, -34.6, -58.4);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.params).toEqual([true, -58.4, -34.6, 30]);
  });

  it('vaga sem coords (serviceLat/Lng null) → applyGeo=false mesmo com raio', () => {
    const spec = new SameZoneSpecification(30, null, null);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.params).toEqual([false, 0, 0, 30]);
  });

  it('placeholders respeitam o paramOffset', () => {
    const spec = new SameZoneSpecification(30, -34.6, -58.4);
    const clause = spec.toSqlClause({ paramOffset: 1 });

    expect(clause.sql).toContain('$2::BOOLEAN');
    expect(clause.sql).toContain('$3::FLOAT');
    expect(clause.sql).toContain('$4::FLOAT');
    expect(clause.sql).toContain('$5::FLOAT');
  });
});
