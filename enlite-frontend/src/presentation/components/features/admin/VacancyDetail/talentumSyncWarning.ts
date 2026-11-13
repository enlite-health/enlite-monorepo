import type { TalentumSync } from '@infrastructure/http/AdminApiService';

/**
 * Chave i18n do aviso quando a edição foi GRAVADA mas não chegou ao Talentum. `OK`/`NOT_PUBLISHED`/ausente → null
 * (nada novo na tela; o feedback de sucesso que já existe continua valendo).
 */
export function talentumSyncWarningKey(sync: TalentumSync | null | undefined): string | null {
  if (sync?.status === 'OTHER_ACCOUNT') return 'admin.vacancyDetail.talentumSync.otherAccount';
  if (sync?.status === 'FAILED') return 'admin.vacancyDetail.talentumSync.failed';
  return null;
}
