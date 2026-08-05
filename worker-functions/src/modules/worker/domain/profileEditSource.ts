/**
 * Fonte canônica de edição de campo de perfil (worker_profile_changes_audit.changed_by).
 *
 * Todo caminho que escreve campo de cadastro atribui uma destas fontes — é o eixo
 * da pergunta "por onde vêm as edições?" (change luz-cadastro-assistido-rastreavel):
 *   - luz_conversation: a Luz gravando na conversa (propose/confirm ou profile.update MCP)
 *   - worker_self:      o próprio prestador na plataforma (/api/workers/me/*, wizard)
 *   - admin_panel:      staff pelo painel admin
 *   - sync_import:      escrita automática de sync/import (reservado; instrumentar ao usar)
 *
 * Linhas históricas gravadas antes do enum têm changed_by='luz' (default da mig 202);
 * leituras agregadas devem normalizá-las para 'luz_conversation'.
 */

import { logger } from '@shared/logging';

export const PROFILE_EDIT_SOURCES = [
  'luz_conversation',
  'worker_self',
  'admin_panel',
  'sync_import',
] as const;

export type ProfileEditSource = (typeof PROFILE_EDIT_SOURCES)[number];

/** Canal (coluna `source` do audit) default por fonte. */
export const DEFAULT_CHANNEL_BY_SOURCE: Record<ProfileEditSource, string> = {
  luz_conversation: 'triage',
  worker_self: 'platform',
  admin_panel: 'admin',
  sync_import: 'sync',
};

/** Atribuição obrigatória de toda escrita de campo de perfil. */
export interface ProfileEditAttribution {
  /** Fonte canônica → worker_profile_changes_audit.changed_by. */
  source: ProfileEditSource;
  /** Identidade pro carimbo transacional set_config('app.current_uid'), ex.: 'luz:profile'. */
  actorUid: string;
  /** Canal detalhado → coluna `source` do audit. Default por fonte. */
  channel?: string;
  conversationRef?: string | null;
  pendingChangeId?: string | null;
}

/**
 * Log estruturado de mensuração `profile_edit` — um por campo escrito.
 * NUNCA carrega o valor do campo (Ley 25.326): só workerId + field + source.
 */
export function logProfileEdit(workerId: string, field: string, source: ProfileEditSource): void {
  logger.child({ workerId }).info({ msg: 'profile_edit', field, source });
}
