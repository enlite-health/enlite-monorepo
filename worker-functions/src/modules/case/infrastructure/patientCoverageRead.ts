/**
 * patientCoverageRead (§C) — a COBERTURA do paciente como o fio a entrega (spec 058 §3.2 §C, §4.5; plan §1.2 B3).
 *
 * `buildCoverage({ informed, entries })` é pura e a ÚNICA que decide `display`/`displaySource`:
 *   INFORMED       a cobertura informada (`patients.insurance_informed`, não vazia) -> `display` = ela
 *   VERIFIED       há entradas verificadas MAPEADAS -> `display` = os nomes do catálogo
 *   UNMAPPED_ONLY  só há entradas sem mapeamento -> `display: null`
 *   NONE           nada -> `display: null`
 * `UNMAPPED_ONLY`/`NONE` <=> `display: null` com o objeto `coverage` PRESENTE (`coverage: null` é "sem permissão", outra coisa). O back só
 * devolve dado: quem traduz "sem mapeamento"/"não informada" é o front (i18n). `entries = { code|null, name|null, mapped, source }`.
 *
 * `coverageEntriesSql(patientIdExpr)` é o ÚNICO texto SQL das entradas: a ficha o embute no SELECT do paciente (zero query a mais) e
 * `readCoverageEntries` o roda sozinho para a rota do serviço (`decorate`) — as duas leem a mesma coisa.
 */
import type { Queryable } from './insuranceContractTermRead';

export interface CoverageEntry {
  /** Código canônico do catálogo; `null` = rótulo cru sem mapeamento. */
  code: string | null;
  /** Nome do catálogo (`insurance_providers.name`); `null` quando sem mapeamento. */
  name: string | null;
  mapped: boolean;
  /** Origem da linha (`clickup`, `panel`...). */
  source: string;
}

export type CoverageDisplaySource = 'INFORMED' | 'VERIFIED' | 'UNMAPPED_ONLY' | 'NONE';

export interface Coverage {
  display: string | null;
  displaySource: CoverageDisplaySource;
  entries: CoverageEntry[];
}

export function buildCoverage(input: { informed: string | null | undefined; entries: readonly CoverageEntry[] }): Coverage {
  const entries = [...input.entries];
  const informed = typeof input.informed === 'string' ? input.informed.trim() : '';
  if (informed !== '') return { display: informed, displaySource: 'INFORMED', entries };
  const names: string[] = [];
  for (const e of entries) if (e.mapped && e.name !== null && !names.includes(e.name)) names.push(e.name);
  if (names.length > 0) return { display: names.join(', '), displaySource: 'VERIFIED', entries };
  if (entries.length > 0) return { display: null, displaySource: 'UNMAPPED_ONLY', entries };
  return { display: null, displaySource: 'NONE', entries };
}

/**
 * Subconsulta (jsonb array, `[]` quando não há linha) das entradas verificadas do paciente `patientIdExpr`: uma por (código, origem) para
 * as mapeadas e UMA POR RÓTULO para as sem mapeamento (o rótulo cru não sai: `name`/`code` nulos). Ordem do catálogo.
 */
export function coverageEntriesSql(patientIdExpr: string): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object('code', x.code, 'name', x.name, 'mapped', x.mapped, 'source', x.source)
                                     ORDER BY x.sort_order, x.code NULLS LAST, x.source, x.ordinal)
                      FROM (SELECT DISTINCT piv.provider_code AS code, ip.name AS name, true AS mapped, piv.source AS source,
                                            ip.sort_order AS sort_order, 0 AS ordinal
                              FROM patient_insurance_verified piv
                              JOIN insurance_providers ip ON ip.code = piv.provider_code
                             WHERE piv.patient_id = ${patientIdExpr} AND piv.provider_code IS NOT NULL
                            UNION ALL
                            SELECT NULL::text, NULL::text, false, piv.source, 2147483647, piv.ordinal::int
                              FROM patient_insurance_verified piv
                             WHERE piv.patient_id = ${patientIdExpr} AND piv.provider_code IS NULL) x), '[]'::jsonb)`;
}

/** As entradas do paciente fora da ficha (rota do serviço): a MESMA subconsulta da ficha. */
export async function readCoverageEntries(q: Queryable, patientId: string): Promise<CoverageEntry[]> {
  const { rows } = await q.query<{ entries: CoverageEntry[] }>(`SELECT ${coverageEntriesSql('$1::uuid')} AS entries`, [patientId]);
  return rows[0]?.entries ?? [];
}
