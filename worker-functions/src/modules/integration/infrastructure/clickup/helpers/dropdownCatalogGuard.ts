/**
 * dropdownCatalogGuard — tells "nobody filled the field" apart from "I could not READ the field".
 *
 * WHY THIS FILE EXISTS (task 1.11 da change `campos-admissao`, achado do QA-caça):
 *
 * `null` coming out of the ClickUp mapping means TWO different things:
 *
 *   (1) the field exists in ClickUp and nobody filled it       → legitimate empty
 *   (2) the field was RENAMED or DELETED in ClickUp, so the    → could not read
 *       name we ask for no longer exists
 *
 * The write path does not distinguish them: `PatientClinicalRepository.upsert` is
 * `UPDATE patients SET clinical_specialty = $11 ...` with `?? null`, so a null from
 * case (2) ERASES, on every re-sync, whatever was stored — while
 * `clickup_patient_sync.completed kind=UPDATED` logs green. Measured exposure at the
 * time of writing: 266 `clinical_specialty`, 348 `dependency_level`, 185 `sex`,
 * 349 `service_type`.
 *
 * NOT `COALESCE` — and this is a decision already taken, not a preference (D-E do
 * `design.md`): fill-only via COALESCE freezes the stored value on EVERY null, which
 * conflates the two cases in the other direction. For a VERIFIED field a frozen value
 * is worse than an empty one, because it still looks like data. Case (1) must keep
 * writing the empty; only case (2) must not write.
 *
 * THE KNOB THAT DISTINGUISHES ALREADY EXISTED: `ClickUpFieldResolver.getFieldType()`
 * answers from the list CATALOG (`/list/<id>/field`) — `'drop_down'` when the field
 * exists under that name, `null` when it does not. Until this guard it had zero
 * callers in `src/`.
 *
 * WHAT THE GUARD DOES: fail closed. If any drop_down field the mapper depends on is
 * not readable, the task is NOT mapped and NOT written — `ClickUpUnreadableFieldError`
 * propagates to `SyncPatientFromClickUpTaskUseCase`, which already has the branch for
 * it (`kind: 'ERROR'` + `clickup_patient_sync.error`). Nothing is erased — not the
 * clinical columns (`PatientClinicalRepository`) and not `sex` (`PatientIdentityRepository`,
 * whose `ON CONFLICT DO UPDATE SET sex = EXCLUDED.sex` no per-column skip would reach) —
 * and the failure is loud instead of a green `UPDATED`.
 *
 * LOG FORMAT — C1 do parecer do `lex` (`parecer-lex-asindexable.md`), and it is a PARE
 * if violated: no raw value of a clinical field goes into a log. What this guard emits
 * is the FIELD NAME plus the CATALOG TYPE — schema metadata, never a patient value:
 * no orderindex, no option uuid, no resolved label, no `task.id`. The alarm the operator
 * needs is "field X can no longer be read", and that is the whole diagnosis: the fix is
 * in the ClickUp field, not in any patient record.
 *
 * ── DEFEITO 1 DO QA-CAÇA DA 2.2: A RÉGUA MEDIA O TIPO, NÃO A LEGIBILIDADE ────
 * Até aqui o guard chumbava `drop_down` como o ÚNICO tipo legível. Medido pelo QA: com o
 * catálogo em que `Segmentos Clínicos` é `labels` — que é o PLANO DECLARADO da Fase 2
 * (D-C: segmento múltiplo) e a premissa da própria C3 do parecer — o mapper lançava
 * `ClickUpUnreadableFieldError`, `SyncPatientFromClickUpTaskUseCase` devolvia `kind=ERROR`
 * e o espelho ClickUp→Postgres PARAVA INTEIRO, de forma muda na origem (o webhook responde
 * `HTTP 200 {"success":true}` com o `kind:'ERROR'` dentro).
 *
 * A pergunta certa nunca foi "este campo é drop_down?" e sim **"o mapper sabe ler o tipo
 * que o catálogo declara HOJE?"**. Por isso a expectativa passa a ser DECLARADA POR CAMPO
 * (`CatalogFieldExpectation`): um campo cujo leitor só entende `drop_down` continua parando
 * o sync quando muda de tipo — que é a proteção da 1.11 e ela fica intacta —, e um campo
 * que o mapper sabe ler nos dois formatos declara os dois e sobrevive à virada.
 *
 * ⚠️ Alargar a lista de tipos aceitos SEM ensinar o mapper a ler o tipo novo seria TROCAR
 * de defeito: o sync voltaria a rodar e gravaria `null` por cima do dado (D167/F41, o `null`
 * que significa duas coisas). Por isso o par obrigatório desta mudança é
 * `helpers/resolveCatalogValue.ts`, que despacha a leitura pelo tipo do catálogo.
 */

import type { ClickUpFieldResolver } from '../ClickUpFieldResolver';

export type DropdownFieldStatus = 'readable' | 'missing' | 'wrong_type';

/**
 * O que o chamador sabe ler de um campo, por campo.
 *
 * `'Nome do Campo'`            → só `drop_down` (o padrão histórico, e o da 1.11).
 * `{ field, accepts: [...] }`  → a lista dos tipos de catálogo que o LEITOR desse campo
 *                                sabe interpretar. Declarar um tipo aqui é um compromisso:
 *                                existe código que lê aquele formato.
 */
export type CatalogFieldExpectation =
  | string
  | { readonly field: string; readonly accepts: readonly string[] };

const DEFAULT_ACCEPTS = ['drop_down'] as const;

/** Normaliza a forma curta (string) na forma completa. Exportada para quem precisa iterar. */
export function normalizeExpectation(
  e: CatalogFieldExpectation,
): { field: string; accepts: readonly string[] } {
  return typeof e === 'string' ? { field: e, accepts: DEFAULT_ACCEPTS } : { field: e.field, accepts: e.accepts };
}

export interface UnreadableDropdownField {
  /** Name we ask ClickUp for. Schema metadata — never a patient value. */
  field: string;
  /** `missing` = no field with this name in the catalog. `wrong_type` = exists, but is a type this reader cannot read. */
  status: Exclude<DropdownFieldStatus, 'readable'>;
  /** The type the catalog reports (`labels`, `short_text`, …), or null when the name is gone. */
  catalogType: string | null;
  /** The types this reader knows how to read for this field. Schema metadata. */
  expected: readonly string[];
}

export class ClickUpUnreadableFieldError extends Error {
  constructor(
    public readonly fields: readonly UnreadableDropdownField[],
    source: string,
  ) {
    const list = fields.map(f => `"${f.field}" (${f.status}${f.catalogType ? `: ${f.catalogType}` : ''})`).join(', ');
    super(
      `${source}: ClickUp catalog field(s) unreadable — ${list}. ` +
      'Task NOT mapped and NOT written: a null derived from a field that cannot be read is ' +
      'indistinguishable from an empty one, and would erase stored data on re-sync. ' +
      'Fix the field name/type in ClickUp (or teach the mapper the new type) and re-run.',
    );
    this.name = 'ClickUpUnreadableFieldError';
  }
}

/**
 * Which of `fields` cannot be read, according to the CATALOG and to what each field's
 * reader declares it understands. Empty array = every field is readable.
 * Never throws, never logs.
 */
export function findUnreadableDropdownFields(
  resolver: Pick<ClickUpFieldResolver, 'getFieldType'>,
  fields: readonly CatalogFieldExpectation[],
): UnreadableDropdownField[] {
  const out: UnreadableDropdownField[] = [];
  for (const raw of fields) {
    const { field, accepts } = normalizeExpectation(raw);
    const catalogType = resolver.getFieldType(field);
    if (catalogType !== null && accepts.includes(catalogType)) continue;
    out.push({
      field,
      status: catalogType === null ? 'missing' : 'wrong_type',
      catalogType,
      expected: accepts,
    });
  }
  return out;
}

/**
 * Fail closed when a catalog field the caller depends on cannot be read.
 * Warns once per unreadable field (C1 format: field name + catalog type, no values),
 * then throws `ClickUpUnreadableFieldError`.
 */
export function assertReadableDropdownFields(
  resolver: Pick<ClickUpFieldResolver, 'getFieldType'>,
  fields: readonly CatalogFieldExpectation[],
  source: string,
): void {
  const unreadable = findUnreadableDropdownFields(resolver, fields);
  if (unreadable.length === 0) return;

  for (const f of unreadable) {
    // C1/lex: field name + catalog type only. No orderindex, no uuid, no label, no task id.
    console.warn(`[${source}] Unreadable ClickUp catalog field (task NOT written — value would be erased):`, {
      field:       f.field,
      status:      f.status,
      expected:    f.expected.join('|'),
      catalogType: f.catalogType,
    });
  }

  throw new ClickUpUnreadableFieldError(unreadable, source);
}
