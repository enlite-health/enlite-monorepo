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
    expect(whereClause).toContain('jp.is_draft = false');
    expect(whereClause).toContain("jp.social_short_links ? 'site'");
    expect(whereClause).toContain('jp.is_test = false');
  });

  it('hides is_test (QA/monitor) vacancies from the public feed — non-negotiable guard', () => {
    // Vaga de teste (job_postings.is_test=true) NUNCA pode aparecer no feed público, mesmo
    // se postada como ACTIVE + is_draft=false + com short link 'site'. Ver follow-up #2.
    const { whereClause } = buildPublicJobsWhere({ country: 'AR' });
    expect(whereClause).toContain('jp.is_test = false');
  });

  it('hides drafts from the public listing (is_draft = false guard is non-negotiable)', () => {
    // Same assertion as above, isolated to fail loudly if anyone removes the
    // draft filter from the base conditions — protects the "incomplete flow ⇒
    // not visible to candidates" invariant added by migration 168.
    const { whereClause } = buildPublicJobsWhere({ country: 'AR' });
    expect(whereClause).toContain('jp.is_draft = false');
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

  // INVERTIDO em 25/08/2026. Era: `adds pathology ILIKE with %val% wrapping`, esperando
  // `p.diagnosis ILIKE $2` — a suite exigia o filtro sobre a coluna clinica.
  it('NUNCA gera condicao sobre a coluna clinica, nem se o filtro for forcado', () => {
    const { whereClause, params } = buildPublicJobsWhere(
      { country: 'AR', pathology: 'Alzheimer' } as never,
    );

    expect(whereClause).not.toContain('diagnosis');
    expect(params).toEqual(['AR']);
    expect(JSON.stringify(params)).not.toContain('Alzheimer');
  });

  it('a busca livre `q` tambem nao toca a coluna clinica', () => {
    const { whereClause } = buildPublicJobsWhere({ country: 'AR', q: 'Alzheimer' });

    // `q` segue funcionando sobre titulo e localidade...
    expect(whereClause).toContain('jp.title ILIKE');
    expect(whereClause).toContain('pa.city ILIKE');
    // ...e NAO sobre a coluna clinica: senao `?q=` seria o mesmo oraculo por outra porta.
    expect(whereClause).not.toContain('diagnosis');
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
    });

    expect(whereClause).toContain('jp.country = $1');
    expect(whereClause).toContain('pa.state ILIKE $2');
    // O 3o placeholder era `p.diagnosis ILIKE $3`. Com o filtro clinico fora, os seguintes
    // sobem uma posicao — e conferir a NUMERACAO importa: `push()` resolve o proximo $N
    // sozinho, entao remover uma condicao no meio renumera tudo em silencio.
    expect(whereClause).toContain('jp.required_sex = $3');
    expect(params).toEqual(['AR', 'CABA', 'FEMALE']);
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
