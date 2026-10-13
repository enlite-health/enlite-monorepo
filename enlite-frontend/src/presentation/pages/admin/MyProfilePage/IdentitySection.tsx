/**
 * IdentitySection — quem é a pessoa logada: avatar (foto se houver, senão a inicial), nome, e-mail e
 * último acesso. Só leitura. A foto vem da sessão do Firebase (`photoUrl`), nunca de backend; para conta Google há uma linha
 * dizendo que nome e foto vêm de lá, com o link para trocá-los. Nome, e-mail e foto (<img src>) ficam sob `data-clarity-mask`
 * (session replay do Clarity, ligado só em PRD — mesmo precedente de `MemberTransfer.tsx`: dado de staff não é gravado). NÃO mostra papel/role: saiu do contrato HTTP de propósito (a verdade é o ABAC, em "Meus accesos").
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, LogOut } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { formatInstant } from '@presentation/utils/dateTimeFormat';
import type { AdminUser } from '@domain/entities/AdminUser';
import { ProfileCard } from './ProfileCard';
import { ProfileField } from './ProfileField';
import { HALVES_GRID } from './profileLayout';

const AVATAR_SIZE = 64;
/** Onde a pessoa troca nome e foto: no Google, não aqui — nada disso é guardado no nosso lado. */
const GOOGLE_ACCOUNT_URL = 'https://myaccount.google.com/personal-info';

interface Props {
  profile: AdminUser;
  locale: string;
  onLogout: () => void;
  /** Foto da conta Google na sessão do navegador; ausente → iniciais. */
  photoUrl?: string | null;
  /** Entrou com a conta Google (nome/foto vêm de lá): mostra a linha com o link "Cambiar en Google". */
  isGoogle: boolean;
}

export function IdentitySection({ profile, locale, onLogout, photoUrl, isGoogle }: Props): JSX.Element {
  const { t } = useTranslation();
  const tt = (key: string): string => t(`admin.profile.identity.${key}`);
  const [photoFailed, setPhotoFailed] = useState(false);
  const name = profile.displayName || profile.email;
  const lastLogin = profile.lastLoginAt
    ? formatInstant(profile.lastLoginAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }, locale)
    : null;

  return (
    <ProfileCard title={tt('title')} testId="profile-identity" className="xl:col-span-2">
      <div className={`${HALVES_GRID} items-center`}>
        <div className="flex flex-col sm:flex-row sm:items-center gap-5 min-w-0 xl:col-start-1" data-clarity-mask="True" data-testid="profile-identity-who">
          {photoUrl && !photoFailed ? (
            <img
              src={photoUrl}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setPhotoFailed(true)}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              className="rounded-full object-cover shrink-0"
              style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
              data-testid="profile-photo"
            />
          ) : (
            <PersonAvatar uid={profile.firebaseUid} name={name} size={AVATAR_SIZE} data-testid="profile-avatar" />
          )}
          <div className="flex flex-col min-w-0">
            <Text color="inherit" as="span" size="lg" weight="semibold" className="text-gray-900 break-words" data-testid="profile-name">{name}</Text>
            <Text color="inherit" as="span" size="sm" className="text-slate-600 break-words" data-testid="profile-email">{profile.email}</Text>
            {isGoogle && (
              <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid="profile-google-note">
                {tt('googleNote')}{' '}
                <a
                  href={GOOGLE_ACCOUNT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline font-medium"
                  data-testid="profile-google-link"
                >
                  {tt('googleLink')}<ExternalLink size={12} aria-hidden="true" />
                </a>
              </Text>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 min-w-0 xl:col-start-3">
          <ProfileField label={tt('lastLogin')} value={lastLogin ?? '—'} testId="profile-last-login" />
          <Button variant="outline" size="md" onClick={onLogout} data-testid="profile-logout">
            <span className="inline-flex items-center gap-2"><LogOut size={16} aria-hidden="true" />{t('admin.profile.session.logout')}</span>
          </Button>
        </div>
      </div>
    </ProfileCard>
  );
}
