/**
 * Redação de valores de perfil pro audit log (worker_profile_changes_audit).
 *
 * A coluna de origem de PII é criptografada via KMS — o audit NÃO pode guardar o
 * valor em claro. Mesma filosofia do McpAuditLogger: last-4 pra documento, ano
 * pra data, máscara pra nome. documentType é indicador (não PII) → passa direto.
 */

const DOCUMENT_NUMBER_FIELDS = new Set(['documentNumber', 'cpf', 'rg']);

export function redactProfileValue(field: string, value: string): string {
  if (DOCUMENT_NUMBER_FIELDS.has(field)) {
    return value.length >= 4 ? `***${value.slice(-4)}` : '***';
  }
  if (field === 'birthDate') {
    return value.length >= 4 ? value.slice(0, 4) : '***';
  }
  if (field === 'documentType') {
    return value; // indicador (DNI/CPF/...), não é PII
  }
  // nomes, endereço e qualquer outro PII → máscara total
  return '***';
}
