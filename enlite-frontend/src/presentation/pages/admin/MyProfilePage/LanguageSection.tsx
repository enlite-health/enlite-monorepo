/**
 * LanguageSection — idioma da interface (es / pt-BR). Reusa o `LanguageSwitcher`, que troca o idioma na hora e
 * grava a escolha em `localStorage['i18nextLng']` (a mesma chave que `i18n/config.ts` lê no próximo carregamento).
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '@presentation/components/shared/LanguageSwitcher';
import { ProfileCard } from './ProfileCard';

export function LanguageSection(): JSX.Element {
  const { t } = useTranslation();
  return (
    <ProfileCard title={t('admin.profile.language.title')} description={t('admin.profile.language.subtitle')} testId="profile-language">
      <LanguageSwitcher />
    </ProfileCard>
  );
}
