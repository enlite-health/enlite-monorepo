// Categoria CID-11 (spec 091, DF-5, DD-18, DD-19): os 4 primeiros caracteres do código. Domínio puro, sem IO.

/** UMA constante para a forma do código de categoria (DD-18). As duas âncoras abaixo e a CHECK da 586 derivam dela. */
export const ICD_CATEGORY_CODE_BODY = '[0-9A-Z]{4}';
/** Prefixo: casa subcódigo e pós-coordenação (`6A02.0`, `KA00.0/XS2R&XS5W`). Usado por `IcdCategoryCode.fromConceptCode`. */
export const ICD_CATEGORY_PREFIX = new RegExp('^' + ICD_CATEGORY_CODE_BODY);
/** Código completo de categoria; usado por zod, pelo lookup (parâmetro SQL) e pelo gerador. */
export const ICD_CATEGORY_CODE_PATTERN = new RegExp('^' + ICD_CATEGORY_CODE_BODY + '$');

export class InvalidIcdCategoryCodeError extends Error {
  readonly code = 'icd_category_invalid';
  constructor() {
    super('icd_category_invalid');
    this.name = 'InvalidIcdCategoryCodeError';
  }
}

/** Value Object: código de categoria CID-11 válido (invariante verificada na fábrica). */
export class IcdCategoryCode {
  private constructor(readonly value: string) {}

  /** `null` quando o código cru não começa com 4 caracteres `[0-9A-Z]`. */
  static fromConceptCode(raw: string | null | undefined): IcdCategoryCode | null {
    const prefix = ICD_CATEGORY_PREFIX.exec(raw ?? '')?.[0];
    return prefix === undefined ? null : new IcdCategoryCode(prefix);
  }

  /** Aceita só o código de categoria completo; senão lança `InvalidIcdCategoryCodeError`. */
  static parse(code: string): IcdCategoryCode {
    if (!ICD_CATEGORY_CODE_PATTERN.test(code)) throw new InvalidIcdCategoryCodeError();
    return new IcdCategoryCode(code);
  }

  equals(other: IcdCategoryCode): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

/** Fachada de uma linha: o dono da regra é o VO `IcdCategoryCode` (DD-19). */
export function icdCategoryOf(code: string | null | undefined): string | null {
  return IcdCategoryCode.fromConceptCode(code)?.value ?? null;
}
