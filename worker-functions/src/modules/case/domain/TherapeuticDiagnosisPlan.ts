// Tipos da cascata do catálogo por CID (spec 091, §9.5). O agregado do bloco (CatalogBlock, DiagnosisPlan…) é da T203.

/** Atividade do catálogo vista pela cascata: pertence a um objetivo e a uma categoria CID-11. */
export interface CascadeActivity {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly suggestedFrequency: string | null;
}

/** Objetivo do catálogo vista pela cascata, com as atividades dele já ordenadas (DD-4). */
export interface CascadeObjective {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly activities: readonly CascadeActivity[];
}
