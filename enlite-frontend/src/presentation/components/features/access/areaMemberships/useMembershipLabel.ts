import { useTranslation } from 'react-i18next';
import type { AreaPersonMembership } from '@domain/entities/AreaMembership';

/** "Care · Familia" — o rótulo do vínculo, o mesmo no chip, no painel e no aria-label. */
export function useMembershipLabel(): (m: Pick<AreaPersonMembership, 'area' | 'role'>) => string {
  const { t } = useTranslation();
  return (m) => `${t(`areas.names.${m.area}`, { defaultValue: m.area })} · ${t(`admin.access.areaMemberships.roles.${m.role}`, { defaultValue: m.role })}`;
}
