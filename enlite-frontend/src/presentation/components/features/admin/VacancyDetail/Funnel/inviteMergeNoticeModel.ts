/**
 * Aviso temporário da mudança (089 ⚑1): "Hacer match" e "Enviar invitaciones" viraram um botão só.
 * Some sozinho nesta data (exclusiva) — 30 dias a partir de 06/11/2026. Se o merge atrasar,
 * ajustar para merge + 30 dias.
 */
export const INVITE_MERGE_NOTICE_UNTIL = '2026-12-06';

const dismissKey = (uid: string | undefined): string =>
  `invite-merge-notice-dismissed-v1-${uid ?? 'anon'}`;

export function isInviteMergeNoticeActive(now: Date = new Date()): boolean {
  return now.getTime() < new Date(`${INVITE_MERGE_NOTICE_UNTIL}T00:00:00`).getTime();
}

export function wasInviteMergeNoticeDismissed(uid: string | undefined): boolean {
  try {
    return localStorage.getItem(dismissKey(uid)) === '1';
  } catch {
    return false; // sem storage: mostra
  }
}

export function dismissInviteMergeNotice(uid: string | undefined): void {
  try {
    localStorage.setItem(dismissKey(uid), '1');
  } catch {
    // sem storage: some só nesta sessão
  }
}
