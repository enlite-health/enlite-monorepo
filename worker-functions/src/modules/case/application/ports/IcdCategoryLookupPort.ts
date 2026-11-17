/** Categoria CID-11 de 4 caracteres, com título do release corrente. */
export interface IcdCategory {
  code: string;
  title: string;
}

/** Porta de leitura de categorias CID-11 do release corrente (spec 091, DD-11, §9.5). */
export interface IcdCategoryLookupPort {
  /** Busca por código ou título; só `kind='stem'` de 4 caracteres; no máximo `limit` (≤20). */
  search(query: string, limit?: number): Promise<IcdCategory[]>;
  /** Títulos por código; código ausente do release corrente fica fora do Map. */
  titlesByCode(codes: readonly string[]): Promise<Map<string, string>>;
  /** O código é categoria (stem de 4 caracteres) no release corrente? */
  isCategory(code: string): Promise<boolean>;
}
