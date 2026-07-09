import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Text } from '@presentation/components/atoms';

/**
 * Placeholder honesto para métricas SEM fonte de dados real (horas estruturadas,
 * ubicaciones/zona normalizada). Não fabrica número — sinaliza pendência.
 */
export function GapNotice({ labelKey }: { labelKey: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid="mgmt-gap-notice"
      className="flex items-start gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
      <div>
        <Text as="p" size="sm" weight="medium" className="text-slate-700">
          {t(labelKey)}
        </Text>
        <Text as="p" size="xs" className="text-slate-500">
          {t('admin.managementDashboard.gap.pending')}
        </Text>
      </div>
    </div>
  );
}
