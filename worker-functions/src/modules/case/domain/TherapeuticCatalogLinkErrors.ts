// Erros nomeados do vínculo item do catálogo ↔ categoria CID-11 (spec 091, §9.4, DD-23). Domínio puro, sem IO.
// Sem ecoar código, id nem texto: o status HTTP sai de uma tabela erro→status no controller.

/** DD-2/DD-23: categoria fora das categorias do objetivo da atividade (FK composta, 23503; cobre a corrida). */
export class IcdCategoryNotInObjectiveError extends Error {
  readonly code = 'icd_category_not_in_objective';
  constructor() {
    super('icd_category_not_in_objective');
    this.name = 'IcdCategoryNotInObjectiveError';
  }
}

/** PK do vínculo (23505): a categoria já está ligada ao item. */
export class IcdCategoryAlreadyLinkedError extends Error {
  readonly code = 'icd_category_already_linked';
  constructor() {
    super('icd_category_already_linked');
    this.name = 'IcdCategoryAlreadyLinkedError';
  }
}

/** Objetivo ou atividade inexistente ao ligar/ler categoria. */
export class CatalogLinkOwnerNotFoundError extends Error {
  readonly code = 'catalog_item_not_found';
  constructor() {
    super('catalog_item_not_found');
    this.name = 'CatalogLinkOwnerNotFoundError';
  }
}
