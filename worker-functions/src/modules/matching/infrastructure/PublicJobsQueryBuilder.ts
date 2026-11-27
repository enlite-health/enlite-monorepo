import type { PublicJobsFilters } from '../domain/PublicJobsFilters';
import { vagaPublicavelSql } from '../domain/vacancyPublication';
import {
  vacancyEffectiveRequiredProfessionsSql,
  vacancyEffectiveRequiredSexSql,
} from '@shared/sql/vacancyEffectiveFieldsSql';

/**
 * Builds the parameterised WHERE clauses and value array for findActivePublic.
 *
 * Uses a mutable params array + a closure that always resolves the NEXT $N
 * placeholder — keeps numbering correct regardless of which optional filters
 * are active.
 */

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
  // "Publicável" tem UM dono (`vacancyPublication.ts`, semaforo-da-vaga F4): não apagada, lançada, não teste (vaga de
  // teste/QA nunca vaza no feed), serviço não inativo, status fora do legado pausado/fechado/baixa e paciente que
  // não pausou a vaga. O chamador põe `LEFT JOIN patients p` no FROM. O feed só acrescenta o que é DELE: o link `site`.
  conditions.push(vagaPublicavelSql('jp', 'p'));
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

  // Removido em 25/08/2026: aqui havia o filtro `pathology`, que casava sobre a coluna
  // clinica de patients. Ver o comentario em PublicJobsFilters.ts -- o controller agora
  // recusa o parametro com 400 em vez de aceita-lo em silencio.

  if (filters.worker_sex) {
    // 057: sexo/profissão efetivos (vaga com serviço lê do serviço); exige `vacancyEffectiveJoinSql('jp')` no FROM do chamador.
    conditions.push(`${vacancyEffectiveRequiredSexSql('jp')} = ${push(filters.worker_sex)}`);
  }

  if (filters.worker_type) {
    conditions.push(`${push(filters.worker_type)} = ANY(${vacancyEffectiveRequiredProfessionsSql('jp')})`);
  }

  if (filters.q) {
    const term = `%${filters.q}%`;
    // Single placeholder reused across OR branches
    const p = push(term);
    // ⚠️ O ramo sobre a coluna clinica do paciente saiu daqui em 25/08/2026, e a busca livre
    // continua funcionando sobre titulo e localidade. Sem isso, `?q=<termo clinico>` era o
    // MESMO oraculo do filtro removido acima, por outra porta: quem quisesse sondar so
    // trocava o nome do parametro. Consertar um e deixar o outro seria consertar a
    // instancia e chamar de classe.
    conditions.push(
      `(jp.title ILIKE ${p} OR COALESCE(pa.neighborhood, p.zone_neighborhood) ILIKE ${p} OR pa.state ILIKE ${p} OR pa.city ILIKE ${p})`,
    );
  }

  const whereClause = `WHERE ${conditions.join('\n         AND ')}`;
  return { whereClause, params };
}
