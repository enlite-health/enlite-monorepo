import type {
  CascadeActivity,
  CascadeBlock,
  CascadeBlockStatus,
  CascadeObjective,
  CascadeResponse,
  DiagnosisPlanInput,
} from './TherapeuticProject';

/**
 * Cascata do "Nuevo" (091, §9.8, DF-6): serviço -> diagnósticos -> por diagnóstico, objetivos -> atividades.
 * Classe PURA e IMUTÁVEL: cada método devolve um NOVO estado (ou `this` quando nada muda). O hook é só o
 * adaptador React. Padrões: Value Object imutável (a classe); Strategy por tabela `status -> regra` (`RULES`),
 * sem `if/switch` por status; Gateway/porta fica fora (a chamada HTTP é do hook).
 */

interface BlockSelection {
  readonly objectiveIds: readonly string[];
  readonly activityIds: readonly string[];
}

const EMPTY_SELECTION: BlockSelection = { objectiveIds: [], activityIds: [] };

/** Strategy: o que cada status de bloco aceita e exige (DD-20: o status do back é o dono de "tem catálogo"). */
interface BlockRule {
  /** Pode marcar objetivo/atividade? */
  readonly allowsSelection: boolean;
  /** A seleção atende o bloco (DF-6: com catálogo ≥1 objetivo e ≥1 atividade; sem catálogo, vazio)? */
  isComplete(selection: BlockSelection): boolean;
}

const RULES: Readonly<Record<CascadeBlockStatus, BlockRule>> = {
  ok: {
    allowsSelection: true,
    isComplete: (s) => s.objectiveIds.length > 0 && s.activityIds.length > 0,
  },
  no_category: { allowsSelection: false, isComplete: (s) => s.objectiveIds.length === 0 && s.activityIds.length === 0 },
  no_catalog: { allowsSelection: false, isComplete: (s) => s.objectiveIds.length === 0 && s.activityIds.length === 0 },
};

const toggled = (ids: readonly string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

export class TherapeuticCascade {
  private constructor(
    readonly serviceCode: string | null,
    readonly blocks: readonly CascadeBlock[],
    private readonly selections: Readonly<Record<string, BlockSelection>>,
  ) {}

  /** Estado inicial: sem serviço, sem blocos, sem seleção (DD-13: Nuevo nasce sem objetivo/atividade). */
  static empty(): TherapeuticCascade {
    return new TherapeuticCascade(null, [], {});
  }

  /** Passo 1. Trocar o serviço zera os blocos e a seleção de todos (DF-6); o mesmo serviço não muda nada. */
  chooseService(serviceCode: string | null): TherapeuticCascade {
    const next = serviceCode || null;
    return next === this.serviceCode ? this : new TherapeuticCascade(next, [], {});
  }

  /** Sem diagnóstico (ou sem serviço) não há bloco: mantém o serviço e esvazia catálogo e seleção. */
  withoutBlocks(): TherapeuticCascade {
    return this.blocks.length === 0 ? this : new TherapeuticCascade(this.serviceCode, [], {});
  }

  /**
   * Aplica a resposta da cascata. A seleção sobrevive só no que ainda existe: bloco removido (diagnóstico tirado)
   * some com a sua; id que saiu do catálogo cai; bloco que deixou de ser `ok` fica vazio. Resposta de outro
   * serviço é ignorada (resposta velha nunca vence a troca).
   */
  withCatalog(response: CascadeResponse): TherapeuticCascade {
    if (response.serviceCode !== this.serviceCode) return this;
    const selections: Record<string, BlockSelection> = {};
    response.blocks.forEach((block) => {
      selections[block.diagnosisUri] = this.pruned(block, this.selectionOf(block.diagnosisUri));
    });
    return new TherapeuticCascade(this.serviceCode, response.blocks, selections);
  }

  /** Passo 3: marca/desmarca o objetivo; desmarcar tira as atividades dele (§9.8). Bloco sem catálogo: nada. */
  toggleObjective(diagnosisUri: string, objectiveId: string): TherapeuticCascade {
    const block = this.blockOf(diagnosisUri);
    const objective = block?.objectives.find((o) => o.id === objectiveId);
    if (!block || !objective || !RULES[block.status].allowsSelection) return this;
    const current = this.selectionOf(diagnosisUri);
    const objectiveIds = toggled(current.objectiveIds, objectiveId);
    return this.withSelection(diagnosisUri, this.pruned(block, { objectiveIds, activityIds: current.activityIds }));
  }

  /** Passo 4: só atividade de objetivo marcado (o passo seguinte só habilita depois do anterior). */
  toggleActivity(diagnosisUri: string, activityId: string): TherapeuticCascade {
    const block = this.blockOf(diagnosisUri);
    if (!block || !RULES[block.status].allowsSelection) return this;
    const current = this.selectionOf(diagnosisUri);
    const available = this.activitiesOf(diagnosisUri).some((a) => a.id === activityId);
    if (!available) return this;
    return this.withSelection(diagnosisUri, { ...current, activityIds: toggled(current.activityIds, activityId) });
  }

  /** Passo 2 só habilita com serviço (`chooseServiceFirst`). */
  canChooseDiagnoses(): boolean {
    return this.serviceCode !== null;
  }

  /** Passo 4 só habilita com ≥1 objetivo marcado no bloco (`pickObjectiveFirst`). */
  canPickActivities(diagnosisUri: string): boolean {
    const block = this.blockOf(diagnosisUri);
    return !!block && RULES[block.status].allowsSelection && this.selectionOf(diagnosisUri).objectiveIds.length > 0;
  }

  isObjectiveSelected(diagnosisUri: string, objectiveId: string): boolean {
    return this.selectionOf(diagnosisUri).objectiveIds.includes(objectiveId);
  }

  isActivitySelected(diagnosisUri: string, activityId: string): boolean {
    return this.selectionOf(diagnosisUri).activityIds.includes(activityId);
  }

  /** Objetivos MARCADOS do bloco, na ordem do catálogo, com as atividades que o catálogo traz. */
  selectedObjectives(diagnosisUri: string): CascadeObjective[] {
    const marked = this.selectionOf(diagnosisUri).objectiveIds;
    return (this.blockOf(diagnosisUri)?.objectives ?? []).filter((o) => marked.includes(o.id));
  }

  /** Atividades visíveis no passo 4: só as dos objetivos marcados, na ordem do catálogo. */
  activitiesOf(diagnosisUri: string): CascadeActivity[] {
    return this.selectedObjectives(diagnosisUri).flatMap((o) => o.activities);
  }

  /** O bloco atende a regra do seu status (`planIncomplete` quando falso). */
  isBlockComplete(diagnosisUri: string): boolean {
    const block = this.blockOf(diagnosisUri);
    return !!block && RULES[block.status].isComplete(this.selectionOf(diagnosisUri));
  }

  /** URIs dos blocos que reprovam — onde a tela mostra `planIncomplete`. */
  incompleteBlocks(): string[] {
    return this.blocks.filter((b) => !this.isBlockComplete(b.diagnosisUri)).map((b) => b.diagnosisUri);
  }

  /** Salvar habilita com serviço, ≥1 bloco e todos os blocos completos pelo `status` (DD-21). */
  canSubmit(): boolean {
    return this.serviceCode !== null && this.blocks.length > 0 && this.incompleteBlocks().length === 0;
  }

  /** `diagnosisPlans` do corpo do `mode:'new'`, na ordem dos blocos (= a das URIs), ids na ordem do catálogo. */
  toRequestBody(): DiagnosisPlanInput[] {
    return this.blocks.map((block) => {
      const sel = this.selectionOf(block.diagnosisUri);
      return {
        diagnosisUri: block.diagnosisUri,
        specificObjectiveIds: block.objectives.map((o) => o.id).filter((id) => sel.objectiveIds.includes(id)),
        activityIds: block.objectives.flatMap((o) => o.activities.map((a) => a.id)).filter((id) => sel.activityIds.includes(id)),
      };
    });
  }

  private blockOf(diagnosisUri: string): CascadeBlock | undefined {
    return this.blocks.find((b) => b.diagnosisUri === diagnosisUri);
  }

  private selectionOf(diagnosisUri: string): BlockSelection {
    return this.selections[diagnosisUri] ?? EMPTY_SELECTION;
  }

  private withSelection(diagnosisUri: string, selection: BlockSelection): TherapeuticCascade {
    return new TherapeuticCascade(this.serviceCode, this.blocks, { ...this.selections, [diagnosisUri]: selection });
  }

  /** Mantém só objetivos do bloco e atividades dos objetivos marcados; bloco que não aceita seleção zera. */
  private pruned(block: CascadeBlock, selection: BlockSelection): BlockSelection {
    if (!RULES[block.status].allowsSelection) return EMPTY_SELECTION;
    const objectives = block.objectives.filter((o) => selection.objectiveIds.includes(o.id));
    const allowedActivities = new Set(objectives.flatMap((o) => o.activities.map((a) => a.id)));
    return {
      objectiveIds: objectives.map((o) => o.id),
      activityIds: selection.activityIds.filter((id) => allowedActivities.has(id)),
    };
  }
}
