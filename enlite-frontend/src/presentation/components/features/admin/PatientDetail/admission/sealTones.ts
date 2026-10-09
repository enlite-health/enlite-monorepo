/**
 * sealTones — estado do selo → tom visual (spec 049, F7). Fora do componente (react-refresh). `Record` fecha o
 * conjunto: um selo ou `import_status` novo no servidor sem tom aqui reprova no tsc.
 */
import type { AdmissionImportStatus, MessageSeal } from '@infrastructure/http/AdminAdmissionApiService';

export type SealTone = 'ok' | 'warn' | 'bad' | 'neutral';

export const MESSAGE_SEAL_TONE: Record<MessageSeal, SealTone> = {
  none: 'neutral',
  scheduled: 'neutral',
  pending: 'neutral',
  sent: 'ok',
  delivered: 'ok',
  failed: 'bad',
  no_consent: 'warn',
  skipped: 'warn',
  cancelled: 'neutral',
};

export const IMPORT_SEAL_TONE: Record<AdmissionImportStatus, SealTone> = {
  pending: 'neutral',
  waiting: 'neutral',
  done: 'ok',
  rejected: 'bad',
  ambiguous: 'warn',
  expired: 'bad',
  blocked: 'bad',
  no_show: 'warn',
};

