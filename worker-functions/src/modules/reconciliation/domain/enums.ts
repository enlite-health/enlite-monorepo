/**
 * reconciliation — enums (spec 003 "Paciente: a plataforma é a fonte da verdade").
 *
 * Todo enum em INGLÊS, SCREAMING_SNAKE_CASE; quem traduz é o frontend.
 * Os CHECKs das migrations 296-299 espelham estas listas — mudar aqui sem
 * migration é bug.
 */

export const SOURCES = ['CLICKUP', 'ANACARE'] as const;
export type Source = (typeof SOURCES)[number];

export const COUNTRIES = ['AR', 'BR'] as const;
export type Country = (typeof COUNTRIES)[number];

export const RUN_COMPLETENESS = ['COMPLETE', 'PARTIAL', 'FAILED'] as const;
export type RunCompleteness = (typeof RUN_COMPLETENESS)[number];

export const RUN_TRIGGERS = ['SCHEDULER', 'MANUAL'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** EXTERNAL_ID = patients.clickup_task_id bate com a task (chave mais forte, só ClickUp). */
export const MATCH_KEYS = ['EXTERNAL_ID', 'DOCUMENT', 'NAME_BIRTHDATE', 'MANUAL', 'NONE'] as const;
export type MatchKey = (typeof MATCH_KEYS)[number];

export const LINK_STATES = ['AUTO', 'AMBIGUOUS', 'CONFIRMED', 'DENIED'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const INVENTORY_BUCKETS = ['ONLY_CLICKUP', 'ONLY_ANACARE', 'BOTH', 'AMBIGUOUS'] as const;
export type InventoryBucket = (typeof INVENTORY_BUCKETS)[number];

export const EQUIVALENCES = ['TEXT_NORM', 'DATE_ISO', 'ENUM_MAP', 'EXACT', 'UNMAPPED'] as const;
export type Equivalence = (typeof EQUIVALENCES)[number];

export const ITEM_STATES = ['PENDING', 'DECIDED', 'SUPERSEDED'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const CHOSEN_SOURCES = ['CLICKUP', 'ANACARE', 'MANUAL'] as const;
export type ChosenSource = (typeof CHOSEN_SOURCES)[number];

export const PROVENANCE_SOURCES = ['CLICKUP', 'ANACARE', 'MANUAL', 'RECONCILIATION'] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/** Advisory lock da rodada de reconciliação. O do espelho ClickUp é 86010723 — nunca reutilizar. */
export const RECONCILIATION_ADVISORY_LOCK_KEY = 86010724;

export function isSource(v: unknown): v is Source {
  return typeof v === 'string' && (SOURCES as readonly string[]).includes(v);
}
export function isCountry(v: unknown): v is Country {
  return typeof v === 'string' && (COUNTRIES as readonly string[]).includes(v);
}
