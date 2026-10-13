/**
 * AccessSection — "Meus accesos": os grupos e os países do usuário logado, lidos do `authz` da store. Só leitura.
 * Deliberadamente SEM a lista crua de células (`recurso:ação`): quem precisa dela usa o painel de acessos.
 * Dado ausente (contrato ainda carregando, ou sem grupo) vira texto de vazio — nunca uma lista inventada.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { SealChip } from '@presentation/components/features/admin/PatientDetail/admission/AdmissionSeals';
import type { AuthzContract } from '@domain/entities/Authz';
import { ProfileCard } from './ProfileCard';

function ChipList({ label, empty, children, testId }: { label: string; empty: string; children: JSX.Element[]; testId: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">{label}</Text>
      {children.length > 0
        ? <div className="flex flex-wrap gap-2">{children}</div>
        : <Text color="inherit" size="sm" className="text-slate-600">{empty}</Text>}
    </div>
  );
}

export function AccessSection({ authz }: { authz: AuthzContract | null }): JSX.Element {
  const { t } = useTranslation();
  const tt = (key: string): string => t(`admin.profile.access.${key}`);
  const groups = authz?.groups ?? [];
  const countries = authz?.countries ?? [];

  return (
    <ProfileCard title={tt('title')} description={tt('subtitle')} testId="profile-access">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-x-8">
      <ChipList label={tt('groups')} empty={tt('noGroups')} testId="profile-groups">
        {groups.map((g) => <SealChip key={g.id} tone="neutral" testId={`profile-group-${g.id}`}>{g.name}</SealChip>)}
      </ChipList>
      <ChipList label={tt('countries')} empty={tt('noCountries')} testId="profile-countries">
        {countries.map((code) => (
          <SealChip key={code} tone="neutral" testId={`profile-country-${code}`}>{t(`admin.profile.access.countryNames.${code}`, { defaultValue: code })}</SealChip>
        ))}
      </ChipList>
      </div>
    </ProfileCard>
  );
}
