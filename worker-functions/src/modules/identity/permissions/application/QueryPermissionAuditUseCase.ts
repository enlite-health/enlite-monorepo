/**
 * Leitura da trilha de decisões. O gate NÃO está aqui: está na função
 * `iam.query_audit` (mig 279/280), que exige `permission_management:read` do
 * ator no GUC e registra o próprio ato de auditar (lex C7). A role do app não
 * tem SELECT na tabela — nem se este use case for chamado por engano.
 *
 * O teto de janela e de linhas existe para a tela não virar exportação: o
 * banco corta em 1000, aqui o default é menor.
 */

import type { PermissionAuditFilters, PermissionAuditRepository, PermissionAuditRow } from './ports';

export const AUDIT_DEFAULT_LIMIT = 200;
export const AUDIT_MAX_LIMIT = 1000;

export class QueryPermissionAuditUseCase {
  constructor(private readonly audit: PermissionAuditRepository) {}

  async execute(filters: PermissionAuditFilters = {}): Promise<PermissionAuditRow[]> {
    const requested = filters.limit ?? AUDIT_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), AUDIT_MAX_LIMIT);
    return this.audit.query({ ...filters, limit });
  }
}
