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

// ---------------------------------------------------------------------------------------------------------------------
// Agregado do bloco por diagnóstico (T203): CatalogBlock (DD-20), regras Strategy por status, DiagnosisPlan, DiagnosisPlans.
// ---------------------------------------------------------------------------------------------------------------------

export type BlockStatus = 'ok' | 'no_category' | 'no_catalog';

/** Entrada do cliente: o que foi marcado num bloco (um por diagnóstico). */
export interface DiagnosisPlanInput {
  readonly diagnosisUri: string;
  readonly specificObjectiveIds: readonly string[];
  readonly activityIds: readonly string[];
}

export interface SnapshotObjective {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
}

/** Snapshot da atividade congelado na versão (rótulo incluso, como o dos objetivos, DD-5). */
export interface SnapshotActivity extends SnapshotObjective {
  readonly suggestedFrequency: string | null;
}

/** Bloco congelado na versão; `categoryCode` é fato congelado de propósito (DD-5). */
export interface DiagnosisPlanSnapshot {
  readonly diagnosisUri: string;
  readonly categoryCode: string | null;
  readonly objectives: readonly SnapshotObjective[];
  readonly activities: readonly SnapshotActivity[];
}

/** Erros nomeados do §9.4 (422; `details` nunca leva URI nem texto). */
abstract class DiagnosisPlanError extends Error {
  abstract readonly code: string;
  constructor(readonly diagnosisIndex: number) {
    super('diagnosis_plan_invalid');
  }
}

export class PlanObjectiveInvalidError extends DiagnosisPlanError {
  readonly code = 'ptp_plan_objective_invalid';
  constructor(diagnosisIndex: number, readonly ids: readonly string[]) {
    super(diagnosisIndex);
  }
}
export class PlanActivityInvalidError extends DiagnosisPlanError {
  readonly code = 'ptp_plan_activity_invalid';
  constructor(diagnosisIndex: number, readonly ids: readonly string[]) {
    super(diagnosisIndex);
  }
}
export class PlanBlockIncompleteError extends DiagnosisPlanError {
  readonly code = 'ptp_plan_block_incomplete';
}
export class PlanBlockWithoutCatalogError extends DiagnosisPlanError {
  readonly code = 'ptp_plan_block_without_catalog';
}

/** Catálogo disponível para uma categoria + serviço. `status()` é o DONO ÚNICO de "bloco tem catálogo" (DD-20). */
export class CatalogBlock {
  constructor(
    readonly categoryCode: string | null,
    readonly objectives: readonly CascadeObjective[],
  ) {}

  status(): BlockStatus {
    return STATUS_OF[String(this.categoryCode !== null)][String(this.objectives.length > 0)];
  }
}
// Tabela em vez de if/else: (tem categoria?) × (tem objetivo?) → status.
const STATUS_OF: Record<string, Record<string, BlockStatus>> = {
  false: { false: 'no_category', true: 'no_category' },
  true: { false: 'no_catalog', true: 'ok' },
};

/** Fachada de uma linha: o dono é `CatalogBlock.status()` (DD-20). */
export function classifyBlock(categoryCode: string | null, objectives: readonly CascadeObjective[]): BlockStatus {
  return new CatalogBlock(categoryCode, objectives).status();
}

/** Strategy: uma regra de seleção por status do bloco. Devolve a seleção (objetivos e atividades) ou lança. */
interface BlockSelection {
  readonly objectives: readonly CascadeObjective[];
  readonly activities: readonly CascadeActivity[];
}
interface BlockSelectionRule {
  apply(input: DiagnosisPlanInput, block: CatalogBlock, diagnosisIndex: number): BlockSelection;
}

const EMPTY_SELECTION: BlockSelection = { objectives: [], activities: [] };

/** Bloco com catálogo: ≥1 objetivo e ≥1 atividade; objetivo ∈ bloco; atividade ∈ atividades dos objetivos marcados. */
class RequiresSelectionRule implements BlockSelectionRule {
  apply(input: DiagnosisPlanInput, block: CatalogBlock, diagnosisIndex: number): BlockSelection {
    const chosen = new Set(input.specificObjectiveIds);
    const chosenActivities = new Set(input.activityIds);
    if (chosen.size === 0 || chosenActivities.size === 0) throw new PlanBlockIncompleteError(diagnosisIndex);

    const known = new Set(block.objectives.map((o) => o.id));
    const unknown = [...chosen].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new PlanObjectiveInvalidError(diagnosisIndex, unknown);

    const objectives = block.objectives.filter((o) => chosen.has(o.id));
    const activities = objectives.flatMap((o) => o.activities).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);
    const allowed = new Set(activities.map((a) => a.id));
    const outside = [...chosenActivities].filter((id) => !allowed.has(id));
    if (outside.length > 0) throw new PlanActivityInvalidError(diagnosisIndex, outside);

    return { objectives, activities: activities.filter((a) => chosenActivities.has(a.id)) };
  }
}

/** Sem categoria ou sem catálogo: a seleção tem de vir vazia. */
class MustBeEmptyRule implements BlockSelectionRule {
  apply(input: DiagnosisPlanInput, _block: CatalogBlock, diagnosisIndex: number): BlockSelection {
    const empty = input.specificObjectiveIds.length === 0 && input.activityIds.length === 0;
    if (!empty) throw new PlanBlockWithoutCatalogError(diagnosisIndex);
    return EMPTY_SELECTION;
  }
}

// Fábrica por tabela status → regra (Strategy).
const RULE_OF: Record<BlockStatus, BlockSelectionRule> = {
  ok: new RequiresSelectionRule(),
  no_category: new MustBeEmptyRule(),
  no_catalog: new MustBeEmptyRule(),
};

/** Entidade imutável: o bloco de um diagnóstico já validado e congelado. */
export class DiagnosisPlan {
  private constructor(readonly snapshot: DiagnosisPlanSnapshot) {}

  static select(input: DiagnosisPlanInput, block: CatalogBlock, diagnosisIndex = 0): DiagnosisPlan {
    const picked = RULE_OF[block.status()].apply(input, block, diagnosisIndex);
    return new DiagnosisPlan(
      Object.freeze({
        diagnosisUri: input.diagnosisUri,
        categoryCode: block.categoryCode,
        objectives: picked.objectives.map(({ id, label, description }) => ({ id, label, description })),
        activities: picked.activities.map(({ id, label, description, suggestedFrequency }) => ({
          id,
          label,
          description,
          suggestedFrequency,
        })),
      }),
    );
  }
}

/** Coleção de primeira classe dos blocos de uma versão. */
export class DiagnosisPlans {
  constructor(readonly plans: readonly DiagnosisPlanSnapshot[]) {}

  /** Lista plana derivada na leitura, nunca gravada (DD-8): união sem repetir id, ordem de aparição. */
  flatten(): { specificObjectives: SnapshotObjective[]; activities: SnapshotActivity[] } {
    const union = <T extends { id: string }>(pick: (p: DiagnosisPlanSnapshot) => readonly T[]): T[] =>
      this.plans.flatMap(pick).filter((item, i, all) => all.findIndex((x) => x.id === item.id) === i);
    return { specificObjectives: union((p) => p.objectives), activities: union((p) => p.activities) };
  }

  /** Comparação MACRO bloco a bloco por `diagnosisUri`: mesmos blocos, mesmos ids de objetivo e de atividade. */
  sameSelectionAs(other: DiagnosisPlans): boolean {
    const key = (p: DiagnosisPlanSnapshot): string =>
      JSON.stringify([[...p.objectives.map((o) => o.id)].sort(), [...p.activities.map((a) => a.id)].sort()]);
    const index = (d: DiagnosisPlans): Map<string, string> => new Map(d.plans.map((p) => [p.diagnosisUri, key(p)] as const));
    const mine = index(this);
    const theirs = index(other);
    return mine.size === theirs.size && [...mine].every(([uri, k]) => theirs.get(uri) === k);
  }
}

/** Fachada: valida todos os blocos (`catalogPorBloco[i]` é o catálogo do bloco `i`, mesma ordem das entradas). */
export function validateDiagnosisPlans(
  inputs: readonly DiagnosisPlanInput[],
  catalogPorBloco: readonly CatalogBlock[],
): DiagnosisPlanSnapshot[] {
  if (inputs.length !== catalogPorBloco.length) throw new RangeError('catalogPorBloco must align with inputs');
  return inputs.map((input, i) => DiagnosisPlan.select(input, catalogPorBloco[i], i).snapshot);
}

/** Fachada: lista plana derivada (DD-8). */
export function flattenDiagnosisPlans(plans: readonly DiagnosisPlanSnapshot[]) {
  return new DiagnosisPlans(plans).flatten();
}
