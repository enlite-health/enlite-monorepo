/**
 * MyProfilePage — /admin/mi-cuenta, "Mi perfil": a conta de quem está logado, numa página só, sem abas.
 * Seções: Identidade (com o "Cerrar sesión") · Tactiq (vínculo + extensão do Chrome) · Idioma · Meus acessos.
 * Fora daqui, de propósito: preferências de notificação, troca de senha, visão padrão do funil.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ContainerGate } from '@presentation/components/features/access/ContainerGate';
import { isGoogleAccount } from '@domain/entities/User';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { IdentitySection } from './IdentitySection';
import TactiqLinkSection from './TactiqLinkSection';
import { LanguageSection } from './LanguageSection';
import { AccessSection } from './AccessSection';

export default function MyProfilePage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const profile = useAdminAuthStore((s) => s.adminProfile);
  const user = useAdminAuthStore((s) => s.user);
  const authz = useAdminAuthStore((s) => s.authz);
  const logout = useAdminAuthStore((s) => s.logout);
  const locale = i18n.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'es-AR';

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/admin/login');
  };

  return (
    <div className="max-w-[1280px] mx-auto flex flex-col gap-6" data-testid="my-profile-page">
      <div className="flex flex-col gap-1">
        <Heading level={1} weight="semibold" color="primary">{t('admin.profile.title')}</Heading>
        <Text color="inherit" size="sm" className="text-slate-600">{t('admin.profile.subtitle')}</Text>
      </div>

      {/* UMA grade de 2 colunas IGUAIS a partir de `xl` (viewport ≥ 1280px; em 768px é 1 coluna), gap-6 nos dois eixos
          (régua em `profileLayout.ts`). Linha 1 Identidad e linha 2 Tactiq ocupam as duas colunas; linha 3 é Idioma |
          Mis accesos, esticados à mesma altura pela própria grade. Abaixo de `xl`: Identidad, Tactiq, Idioma, Accesos.
          Sem a permissão do Tactiq a página segue simétrica (Identidad + linha 3). */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {profile && <IdentitySection profile={profile} locale={locale} onLogout={() => { void handleLogout(); }} photoUrl={user?.photoUrl} isGoogle={isGoogleAccount(user)} />}
        {/* O vínculo do Tactiq é gateado pela mesma célula de antes (`own_tactiq_link:read`): sem ela a seção nem existe. */}
        <ContainerGate resource="own_tactiq_link"><TactiqLinkSection /></ContainerGate>
        <LanguageSection />
        <AccessSection authz={authz} />
      </div>
    </div>
  );
}
