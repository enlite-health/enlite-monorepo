import type { PublicJobsFilters } from '../domain/PublicJobsFilters';

/**
 * Builds the parameterised WHERE clauses and value array for findActivePublic.
 *
 * Uses a mutable params array + a closure that always resolves the NEXT $N
 * placeholder — keeps numbering correct regardless of which optional filters
 * are active.
 */

const ACTIVE_STATUSES = `('ACTIVE','SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')`;

export interface WhereClauseResult {
  /** Complete WHERE … block (already prefixed with "WHERE ") */
  whereClause: string;
  /** Ordered bind-value array — pass directly to pool.query() */
  params: unknown[];
}

export function buildPublicJobsWhere(filters: PublicJobsFilters): WhereClauseResult {
  const params: unknown[] = [];
  const conditions: string[] = [];

  /** Push a value and return its $N placeholder. */
  function push(value: unknown): string {
    params.push(value);
    return `$${params.length}`;
  }

  // ── Fixed base conditions ────────────────────────────────────────────────────
  conditions.push(`jp.status IN ${ACTIVE_STATUSES}`);
  conditions.push(`jp.deleted_at IS NULL`);
  conditions.push(`jp.is_draft = false`);
  conditions.push(`jp.social_short_links ? 'site'`);

  // ── country (always present — default 'AR') ──────────────────────────────────
  conditions.push(`jp.country = ${push(filters.country)}`);

  // ── Optional filters ─────────────────────────────────────────────────────────
  if (filters.state) {
    conditions.push(`pa.state ILIKE ${push(filters.state)}`);
  }

  if (filters.city) {
    conditions.push(`pa.city ILIKE ${push(filters.city)}`);
  }

  if (filters.pathology) {
    conditions.push(`p.diagnosis ILIKE ${push(`%${filters.pathology}%`)}`);
  }

  if (filters.worker_sex) {
    conditions.push(`jp.required_sex = ${push(filters.worker_sex)}`);
  }

  if (filters.worker_type) {
    conditions.push(`${push(filters.worker_type)} = ANY(jp.required_professions)`);
  }

  if (filters.q) {
    const term = `%${filters.q}%`;
    // Single placeholder reused across OR branches
    const p = push(term);
    conditions.push(
      `(jp.title ILIKE ${p} OR p.diagnosis ILIKE ${p} OR COALESCE(pa.neighborhood, p.zone_neighborhood) ILIKE ${p} OR pa.state ILIKE ${p} OR pa.city ILIKE ${p})`,
    );
  }

  const whereClause = `WHERE ${conditions.join('\n         AND ')}`;
  return { whereClause, params };
}
