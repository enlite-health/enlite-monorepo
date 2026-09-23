/**
 * Leitura do histórico de mudanças de permissão. Molde de
 * `QueryPermissionAuditUseCase`: o gate NÃO está aqui — está na função
 * `iam.query_permission_history` (mig 458), que exige `permission_management:
 * read` do ator no GUC. A role do app não tem SELECT direto nas tabelas
 * fonte por este caminho (a leitura sempre passa pela função).
 *
 * O teto de linhas existe pelo mesmo motivo da auditoria: a tela não vira
 * exportação. O banco corta em 1000; aqui o default é menor.
 */

import type {
  PermissionHistoryFilters,
  PermissionHistoryRepository,
  PermissionHistoryEvent,
} from './ports';

export const HISTORY_DEFAULT_LIMIT = 200;
export const HISTORY_MAX_LIMIT = 1000;

export class QueryPermissionHistoryUseCase {
  constructor(private readonly history: PermissionHistoryRepository) {}

  async execute(filters: PermissionHistoryFilters = {}): Promise<PermissionHistoryEvent[]> {
    const requested = filters.limit ?? HISTORY_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), HISTORY_MAX_LIMIT);
    return this.history.query({ ...filters, limit });
  }
}
