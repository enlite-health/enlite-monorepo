/**
 * Badge de origem do check-in. Local à feature (não é atom compartilhado) — segue o MOLDE dos
 * atoms `DocsStatusBadge`/`VacancyStatusBadge`: pill com `Text` interno, nunca tipografia crua.
 * "Sin check-in" e "Web admin" recebem destaque (regra travada); "App" é neutro/positivo.
 * Portado sem mudança de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHours/OriginBadge.tsx`.
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { CheckInOrigin } from './types';

const CONFIG: Record<CheckInOrigin, { key: string; descriptionKey: string; bg: string; text: string; dot: string }> = {
  sin_checkin: { key: 'sinCheckin', descriptionKey: 'descriptionSinCheckin', bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  web_admin: { key: 'webAdmin', descriptionKey: 'descriptionWebAdmin', bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
  app: { key: 'app', descriptionKey: 'descriptionApp', bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
};

export function OriginBadge({ origin, className = '' }: { origin: CheckInOrigin; className?: string }): JSX.Element {
  const { t } = useTranslation();
  const cfg = CONFIG[origin];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full ${cfg.bg} ${cfg.text} ${className}`}
      title={t(`admin.anacareHours.origin.${cfg.descriptionKey}`)}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t(`admin.anacareHours.origin.${cfg.key}`)}
      </Text>
    </span>
  );
}
