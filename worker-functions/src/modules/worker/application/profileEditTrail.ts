import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { ProfileChangeAuditRepository } from '../infrastructure/ProfileChangeAuditRepository';
import { redactProfileValue } from './profileChangeRedaction';
import { DEFAULT_CHANNEL_BY_SOURCE, ProfileEditAttribution, logProfileEdit } from '../domain/profileEditSource';

/** Um campo de perfil que mudou (valor em claro só em memória; a trilha grava redigido). */
export interface ProfileFieldChange {
  field: string;
  oldValue: string;
  newValue: string;
}

export function normalizeForDiff(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).join(', ');
  return String(value).trim();
}

/** Pares [campo, antes, depois] para os que mudaram; vazio no depois não sobrescreve (COALESCE no repositório). */
export function changedFields(pairs: ReadonlyArray<readonly [string, unknown, unknown]>): ProfileFieldChange[] {
  const out: ProfileFieldChange[] = [];
  for (const [field, before, after] of pairs) {
    const newValue = normalizeForDiff(after);
    if (newValue === '') continue;
    const oldValue = normalizeForDiff(before);
    if (newValue !== oldValue) out.push({ field, oldValue, newValue });
  }
  return out;
}

/**
 * Trilha de fonte (worker_profile_changes_audit): changed_by = fonte; source = canal (default por fonte).
 * Best-effort: falha não derruba o save. Sem pool injetado, usa o DatabaseConnection, resolvido aqui dentro.
 */
export async function recordProfileEditTrail(
  workerId: string,
  changed: ProfileFieldChange[],
  attribution: Pick<ProfileEditAttribution, 'source' | 'channel'>,
  pool?: Pool,
): Promise<void> {
  if (changed.length === 0) return;
  try {
    const db = pool ?? (require('@shared/database/DatabaseConnection') as typeof import('@shared/database/DatabaseConnection')).DatabaseConnection.getInstance().getPool();
    const source = attribution.channel ?? DEFAULT_CHANNEL_BY_SOURCE[attribution.source];
    await new ProfileChangeAuditRepository(db).recordBatch(
      changed.map(({ field, oldValue, newValue }) => ({
        workerId,
        pendingChangeId: null,
        fieldName: field,
        oldValueRedacted: oldValue === '' ? null : redactProfileValue(field, oldValue),
        newValueRedacted: redactProfileValue(field, newValue),
        changedBy: attribution.source,
        source,
        conversationRef: null,
      })),
    );
    for (const { field } of changed) logProfileEdit(workerId, field, attribution.source);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.child({ workerId }).warn({ msg: '[profileEditTrail] failed to record edit trail (best-effort, ignoring)', error: e.message });
  }
}
