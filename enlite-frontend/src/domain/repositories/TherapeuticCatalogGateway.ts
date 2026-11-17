/**
 * Porta do front para o catálogo terapêutico por CID-11 e serviço (spec 091, prompt §3.3).
 * Implementada por `AdminTherapeuticProjectsApiService` (infraestrutura); hooks e testes recebem a porta,
 * e os testes usam um fake dela — não um mock de `fetch`. Domínio puro: sem framework, sem rede.
 */
import type {
  AddedCategoryLink,
  AdminCatalogKind,
  CascadeRequestBody,
  CascadeResponse,
  CatalogItemBody,
  CatalogListOptions,
  CategoryLinkList,
  IcdCategory,
  RemovedActivityCategory,
  RemovedObjectiveCategory,
  TherapeuticCatalogItem,
} from '../entities/TherapeuticProject';

export interface TherapeuticCatalogGateway {
  listCatalog(kind: AdminCatalogKind, opts?: CatalogListOptions): Promise<TherapeuticCatalogItem[]>;
  createCatalogItem(kind: AdminCatalogKind, body: CatalogItemBody): Promise<TherapeuticCatalogItem>;
  updateCatalogItem(kind: AdminCatalogKind, itemId: string, body: CatalogItemBody): Promise<TherapeuticCatalogItem>;

  /** POST …/cascade — blocos na ordem das URIs; 422 `ptp_diagnosis_unknown`, 503 terminologia fora. */
  cascade(body: CascadeRequestBody): Promise<CascadeResponse>;
  /** GET …/icd-categories?q= — até 20 categorias do release corrente. */
  searchIcdCategories(q: string): Promise<IcdCategory[]>;

  listObjectiveCategories(objectiveId: string): Promise<CategoryLinkList>;
  addObjectiveCategory(objectiveId: string, code: string): Promise<AddedCategoryLink>;
  removeObjectiveCategory(objectiveId: string, code: string): Promise<RemovedObjectiveCategory>;

  listActivityCategories(activityId: string): Promise<CategoryLinkList>;
  addActivityCategory(activityId: string, code: string): Promise<AddedCategoryLink>;
  removeActivityCategory(activityId: string, code: string): Promise<RemovedActivityCategory>;
}
