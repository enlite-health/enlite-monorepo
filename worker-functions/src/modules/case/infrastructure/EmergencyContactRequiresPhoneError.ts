/**
 * 422 — a marca de emergência exige um contato ATIVO e com telefone (migration 423, spec 018
 * PR-2, D-A #3/#4, SUP-40). Três gatilhos no banco, todos SQLSTATE 23514, mapeados para o MESMO
 * código de erro público (`contracts/support-network.md`):
 *   1. `PUT /patients/:id/emergency-contact` apontando para um contato inativo ou sem telefone
 *      (`fn_patients_emergency_mark_valida`).
 *   2/3. `PATCH /patients/:id/{responsibles,external-contacts}/:rid` apagando o telefone (`null`)
 *      de uma linha que ESTÁ marcada de emergência (`fn_..._bloqueia_apaga_telefone_marcado`).
 */
export class EmergencyContactRequiresPhoneError extends Error {
  readonly code = 'EMERGENCY_CONTACT_REQUIRES_PHONE';
  constructor() {
    super('O contato de emergência precisa estar ativo e ter telefone');
    this.name = 'EmergencyContactRequiresPhoneError';
  }
}

const EMERGENCY_MARK_CHECK_VIOLATION = '23514';

/** Reconhece o SQLSTATE dos 3 triggers da migration 423 — nunca inspeciona a mensagem (i18n/PII-safe). */
export function isEmergencyMarkCheckViolation(err: unknown): boolean {
  const pgErr = err as { code?: string } | null;
  return pgErr?.code === EMERGENCY_MARK_CHECK_VIOLATION;
}
