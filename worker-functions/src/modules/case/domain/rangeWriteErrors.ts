/**
 * Erros de domínio das escritas com vigência (termo de contrato e vínculo serviço -> contrato; spec 058 §3.2 §E/§W).
 * Cada um sabe o próprio status HTTP e código (`insuranceErrorResponse` os devolve sem tabela por controller).
 */
abstract class RangeWriteError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;
}

/** 422 — troca/termo novo começando no MESMO dia do registro vivo: o trecho anterior ficaria vazio; é CORREÇÃO, não troca. */
export class SameStartUseCorrectionError extends RangeWriteError {
  readonly httpStatus = 422;
  readonly code = 'SAME_START_USE_CORRECTION';
  constructor() {
    super('A vigência começa no mesmo dia do registro vivo: use correção');
    this.name = 'SameStartUseCorrectionError';
  }
}

/** 422 — a vigência pedida não cabe no registro substituído (`validFrom` antes do início ou depois do fim dele; fim antes do início). */
export class RangeInvalidError extends RangeWriteError {
  readonly httpStatus = 422;
  readonly code: string;
  constructor(code: 'TERM_RANGE_INVALID' | 'LINK_RANGE_INVALID') {
    super('A vigência pedida não cabe no registro substituído');
    this.code = code;
    this.name = 'RangeInvalidError';
  }
}
