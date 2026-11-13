import { describe, it, expect } from 'vitest';
import { talentumSyncWarningKey } from '../talentumSyncWarning';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const lookup = (obj: any, key: string) => key.split('.').reduce((o, k) => o?.[k], obj);

describe('talentumSyncWarningKey', () => {
  it('OTHER_ACCOUNT e FAILED avisam; OK, NOT_PUBLISHED e ausente não mostram nada', () => {
    expect(talentumSyncWarningKey({ status: 'OTHER_ACCOUNT' })).toBe('admin.vacancyDetail.talentumSync.otherAccount');
    expect(talentumSyncWarningKey({ status: 'FAILED' })).toBe('admin.vacancyDetail.talentumSync.failed');
    expect(talentumSyncWarningKey({ status: 'OK' })).toBeNull();
    expect(talentumSyncWarningKey({ status: 'NOT_PUBLISHED' })).toBeNull();
    expect(talentumSyncWarningKey(undefined)).toBeNull();
  });

  it('as duas chaves existem em es E pt-BR (texto fixo é defeito)', () => {
    for (const status of ['OTHER_ACCOUNT', 'FAILED'] as const) {
      const key = talentumSyncWarningKey({ status })!;
      expect(typeof lookup(es, key)).toBe('string');
      expect(typeof lookup(ptBR, key)).toBe('string');
    }
  });
});
