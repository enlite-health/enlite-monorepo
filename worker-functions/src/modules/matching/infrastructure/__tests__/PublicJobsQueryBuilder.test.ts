/**
 * PublicJobsQueryBuilder.test.ts
 *
 * Scenarios:
 *   1. country only (default AR) — generates correct $1 placeholder
 *   2. state filter adds ILIKE clause
 *   3. city filter adds ILIKE clause
 *   4. pathology filter adds ILIKE '%val%' clause
 *   5. worker_sex filter adds = clause
 *   6. worker_type filter adds = ANY() clause
 *   7. q filter adds OR block across title/diagnosis/neighborhood/state/city with single placeholder
 *   8. Multiple filters combined — placeholder numbering is sequential
 *   9. Params array length matches placeholder count
 */

import { buildPublicJobsWhere } from '../PublicJobsQueryBuilder';

describe('buildPublicJobsWhere', () => {
  it('generates WHERE with country = $1 when only country is provided', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR' });

    expect(whereClause).toContain('jp.country = $1');
    expect(params).toEqual(['AR']);
  });

  it('includes fixed base conditions regardless of filters', () => {
    const { whereClause } = buildPublicJobsWhere({ country: 'AR' });

    expect(whereClause).toContain("jp.status IN ('ACTIVE','SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')");
    expect(whereClause).toContain('jp.deleted_at IS NULL');
    expect(whereClause).toContain("jp.social_short_links ? 'site'");
  });

  it('adds state ILIKE clause with next placeholder', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR', state: 'CABA' });

    expect(whereClause).toContain('jp.country = $1');
    expect(whereClause).toContain('pa.state ILIKE $2');
    expect(params).toEqual(['AR', 'CABA']);
  });

  it('adds city ILIKE clause', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR', city: 'Palermo' });

    expect(whereClause).toContain('pa.city ILIKE $2');
    expect(params).toEqual(['AR', 'Palermo']);
  });

  it('adds pathology ILIKE with %val% wrapping', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR', pathology: 'Alzheimer' });

    expect(whereClause).toContain('p.diagnosis ILIKE $2');
    expect(params).toEqual(['AR', '%Alzheimer%']);
  });

  it('adds worker_sex exact match clause', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR', worker_sex: 'FEMALE' });

    expect(whereClause).toContain('jp.required_sex = $2');
    expect(params).toEqual(['AR', 'FEMALE']);
  });

  it('adds worker_type = ANY() clause', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR', worker_type: 'AT' });

    expect(whereClause).toContain('= ANY(jp.required_professions)');
    expect(params).toEqual(['AR', 'AT']);
  });

  it('q filter reuses a single placeholder across all OR branches', () => {
    const { whereClause, params } = buildPublicJobsWhere({ country: 'AR', q: 'temperley' });

    // The q block should have exactly one placeholder ($2) reused in the OR
    const matches = whereClause.match(/\$2/g);
    expect(matches).not.toBeNull();
    // All five ILIKE targets share $2
    expect(matches!.length).toBeGreaterThanOrEqual(4);
    expect(params).toEqual(['AR', '%temperley%']);
  });

  it('combines multiple filters with sequential placeholders', () => {
    const { whereClause, params } = buildPublicJobsWhere({
      country: 'AR',
      state: 'CABA',
      worker_sex: 'FEMALE',
      pathology: 'TEA',
    });

    expect(whereClause).toContain('jp.country = $1');
    expect(whereClause).toContain('pa.state ILIKE $2');
    expect(whereClause).toContain('p.diagnosis ILIKE $3');
    expect(whereClause).toContain('jp.required_sex = $4');
    expect(params).toEqual(['AR', 'CABA', '%TEA%', 'FEMALE']);
  });

  it('params length matches the highest placeholder number used', () => {
    const { whereClause, params } = buildPublicJobsWhere({
      country: 'BR',
      state: 'SP',
      city: 'São Paulo',
      worker_type: 'CUIDADOR',
    });

    // Should have $1 (country) $2 (state) $3 (city) $4 (worker_type) = 4 params
    expect(params.length).toBe(4);
    expect(whereClause).toContain('$4');
    expect(whereClause).not.toContain('$5');
  });
});
