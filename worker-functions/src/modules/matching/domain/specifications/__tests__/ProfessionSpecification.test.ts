import { ProfessionSpecification } from '../ProfessionSpecification';

describe('ProfessionSpecification', () => {
  it('requiredProfessions null → binda null (sem restrição)', () => {
    const spec = new ProfessionSpecification(null);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.params).toEqual([null]);
  });

  it('requiredProfessions preenchido → binda JSON stringificado', () => {
    const spec = new ProfessionSpecification(['AT', 'CUIDADOR']);
    const clause = spec.toSqlClause({ paramOffset: 0 });

    expect(clause.params).toEqual([JSON.stringify(['AT', 'CUIDADOR'])]);
  });

  it('mesmo placeholder reusado nas duas metades do OR', () => {
    const spec = new ProfessionSpecification(['AT']);
    const clause = spec.toSqlClause({ paramOffset: 3 });

    expect(clause.sql).toBe('$4::JSONB IS NULL OR $4::JSONB ? COALESCE(w.occupation, w.profession)');
    expect(clause.params).toHaveLength(1);
  });
});
