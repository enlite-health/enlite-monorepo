export interface CategoryLink {
  code: string;
  /** Título do release corrente; `null` = código ausente nele. */
  title: string | null;
  /** Só no vínculo de objetivo: quantas atividades dele usam a categoria. */
  activityLinks?: number;
}
export interface CategoryLinkList { total: number; items: CategoryLink[] }

/** Porta dos vínculos item do catálogo ↔ categoria CID-11 (spec 091, §9.4, DD-23); erros de domínio nomeados, sem SQL. */
export interface TherapeuticCatalogLinkPort {
  listObjectiveCategories(objectiveId: string): Promise<CategoryLinkList>;
  listActivityCategories(activityId: string): Promise<CategoryLinkList>;
  addObjectiveCategory(objectiveId: string, rawCode: string, actorUid: string): Promise<CategoryLink>;
  addActivityCategory(activityId: string, rawCode: string, actorUid: string): Promise<CategoryLink>;
  removeObjectiveCategory(objectiveId: string, rawCode: string): Promise<{ removedActivityLinks: number }>;
  removeActivityCategory(activityId: string, rawCode: string): Promise<{ removed: boolean }>;
}
