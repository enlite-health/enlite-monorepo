/**
 * src/modules/identity/permissions/domain/PermissionHistory.ts
 *
 * Histórico de mudanças de permissão — a pergunta "quem mudou o quê, em qual
 * grupo, quando" (substitui a Auditoría de decisiones ALLOW/DENY na UI). Um
 * evento é UM dos dois tipos, nunca os dois: `permission` (célula
 * adicionada/removida de um grupo, `iam.permission_group_changes`) ou `member`
 * (pessoa adicionada/removida de um grupo, `iam.user_groups` — uma linha vira
 * até DOIS eventos, um por `assigned_at` e outro por `removed_at` quando
 * existir).
 *
 * `reason` de `permission_group_changes` NUNCA entra aqui — texto livre, pode
 * conter dado sensível, e a spec da tela proíbe expor.
 */

export type PermissionHistoryEventType = 'permission' | 'member';
export type PermissionHistoryOp = 'add' | 'remove';

export interface PermissionHistoryEvent {
  eventType: PermissionHistoryEventType;
  occurredAt: Date;
  groupId: string;
  groupName: string;
  actorUid: string | null;
  actorDisplayName: string | null;
  actorEmail: string | null;
  op: PermissionHistoryOp;
  /** Só em eventos `permission` — resource+action da célula. */
  resource: string | null;
  action: string | null;
  /** Só em eventos `member` — quem entrou/saiu do grupo. */
  subjectUserId: string | null;
  subjectDisplayName: string | null;
  subjectEmail: string | null;
}
