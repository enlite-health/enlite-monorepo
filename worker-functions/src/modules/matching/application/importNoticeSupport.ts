import type { PoolClient } from 'pg';
import { IMPORT_EXPIRE_AFTER_MS } from '../domain/admissionImport';
import { HUMAN_BLOCK_REASONS, type HumanBlockReason } from '../domain/importBlockPolicy';
import type { ImportBlockNotice, ImportBlockNoticePort, ImportSubject } from './ports/ImportPorts';

export const isHumanReason = (r: string | null | undefined): r is HumanBlockReason => (HUMAN_BLOCK_REASONS as readonly string[]).includes(r ?? '');

/** Até quando a gravação pode ser recuperada: fim real da call + 72 h (a mesma conta do `expire`). */
export const deadlineOf = (endedAt: Date): Date => new Date(endedAt.getTime() + IMPORT_EXPIRE_AFTER_MS);

/** Aviso do sujeito (reunião da admissão ou evento do enquadre) dentro da transação `cli`. Sem porto = no-op. */
export async function noticeSubject(
  notices: ImportBlockNoticePort | undefined,
  cli: PoolClient,
  a: ImportSubject,
  n: Pick<ImportBlockNotice, 'stage' | 'reason' | 'warnManagement'>,
): Promise<void> {
  await notices?.notify(cli, { ...n, hostEmail: a.host_email, meetingAt: a.slot_start, deadlineAt: deadlineOf(a.conference_ended_at as Date) });
}
