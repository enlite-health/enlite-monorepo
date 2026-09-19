/**
 * documentNumber — normalização e validação PURA de `document_number` de paciente (DNI
 * argentino), criada na correção do dedupe do Axonico (F2, 18/09/2026): o defeito original
 * chaveava o dedupe local por `patient_id`, mas o Axonico fatura pelo DNI (via `historia_clinica`)
 * — dois cadastros nossos podem compartilhar o mesmo DNI e nenhum dos dois é bloqueado sozinho.
 * Medido em produção, no mesmo levantamento: **19 pacientes têm a string literal `'null'`** (4
 * caracteres) em `document_number` — não é `NULL` do SQL, e um guard que só checa `IS NULL` deixa
 * passar. Esta função existe para ser a ÚNICA porta de entrada dessa checagem — nunca reimplementar
 * o regex inline num guard.
 *
 * Contrato do retorno — o chamador PRECISA distinguir "ausente" de "inválido" (guard 0 do use case
 * usa isso para diferenciar `PacienteSemDniError('no_document')` de
 * `PacienteSemDniError('invalid_document')`, mensagens diferentes para o operador):
 *   - `{ valid: true, normalized: string }` — 7 ou 8 dígitos depois de tirar espaço/ponto/traço.
 *   - `{ valid: false, reason: 'ausente' }` — `null`, `undefined`, ou string vazia/só espaço
 *     depois de normalizada.
 *   - `{ valid: false, reason: 'invalido' }` — tem conteúdo, mas não é um DNI válido: string
 *     literal `'null'`/`'undefined'`, não-numérico, ou fora da faixa 7-8 dígitos.
 */

export interface DocumentNumberValid {
  readonly valid: true;
  /** DNI só com dígitos — espaço, ponto e traço removidos. */
  readonly normalized: string;
}

export interface DocumentNumberInvalid {
  readonly valid: false;
  /** 'ausente' = não havia dado nenhum; 'invalido' = havia dado, mas não é um DNI válido. */
  readonly reason: 'ausente' | 'invalido';
}

export type DocumentNumberValidation = DocumentNumberValid | DocumentNumberInvalid;

/** Tira espaço, ponto e traço — formatação comum de DNI ('30.111.222', '30 111 222'). */
function stripFormatting(value: string): string {
  return value.replace(/[\s.-]/g, '');
}

/**
 * Normaliza e valida um `document_number` de paciente. Nunca lança — todo caso de entrada
 * inválida vira `{ valid: false, reason }`, nunca uma exceção.
 */
export function normalizeAndValidateDocumentNumber(
  raw: string | null | undefined,
): DocumentNumberValidation {
  if (raw === null || raw === undefined) {
    return { valid: false, reason: 'ausente' };
  }
  if (typeof raw !== 'string') {
    // Defensivo — o tipo da assinatura já proíbe isto, mas um chamador em JS puro (ou `any`)
    // pode violar o contrato; nunca deixar passar pro regex abaixo com um valor não-string.
    return { valid: false, reason: 'invalido' };
  }

  const stripped = stripFormatting(raw.trim());

  if (stripped === '') {
    return { valid: false, reason: 'ausente' };
  }

  // A string literal 'null'/'undefined' (19 pacientes medidos com 'null' em produção) não é o
  // `NULL` do SQL — passa por `document_number IS NOT NULL` sem problema, e por isso precisa de
  // rejeição EXPLÍCITA aqui, antes mesmo do regex (que já a rejeitaria por não ser numérica, mas
  // o caso fica nomeado — clareza para quem lê o teste e para quem debuga um guard recusado).
  const lower = stripped.toLowerCase();
  if (lower === 'null' || lower === 'undefined') {
    return { valid: false, reason: 'invalido' };
  }

  // DNI argentino: 7 ou 8 dígitos, só numérico depois de normalizado.
  if (!/^\d{7,8}$/.test(stripped)) {
    return { valid: false, reason: 'invalido' };
  }

  return { valid: true, normalized: stripped };
}
