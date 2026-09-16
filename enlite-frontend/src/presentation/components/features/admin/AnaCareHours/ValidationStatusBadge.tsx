/** Portado sem mudança de `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHours/ValidationStatusBadge.tsx`. */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { ValidationStatus } from './types';

const CONFIG: Record<ValidationStatus, { bg: string; text: string }> = {
  pendiente: { bg: 'bg-gray-300', text: 'text-gray-800' },
  validado: { bg: 'bg-green-100', text: 'text-green-700' },
  contestado: { bg: 'bg-red-100', text: 'text-red-700' },
};

export function ValidationStatusBadge({ status }: { status: ValidationStatus }): JSX.Element {
  const { t } = useTranslation();
  const cfg = CONFIG[status];
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full ${cfg.bg} ${cfg.text}`}>
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t(`admin.anacareHours.status.${status}`)}
      </Text>
    </span>
  );
}
