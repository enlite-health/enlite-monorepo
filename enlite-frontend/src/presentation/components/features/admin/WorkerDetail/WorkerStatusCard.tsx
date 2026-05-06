import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { getPlatformLabel } from '@presentation/pages/admin/workersData';

interface WorkerStatusCardProps {
  status: string;
  dataSources: string[];
  platform: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  REGISTERED: 'bg-green-100 text-green-700',
  INCOMPLETE_REGISTER: 'bg-yellow-100 text-yellow-700',
  DISABLED: 'bg-red-100 text-red-700',
};

const STATUS_I18N_KEYS: Record<string, string> = {
  REGISTERED: 'admin.workerDetail.statusRegistered',
  INCOMPLETE_REGISTER: 'admin.workerDetail.statusIncomplete',
  DISABLED: 'admin.workerDetail.statusDisabled',
};

export function WorkerStatusCard({
  status,
  dataSources,
  platform,
  createdAt,
  updatedAt,
}: WorkerStatusCardProps) {
  const { t } = useTranslation();
  const colorClass = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';
  const statusLabel = STATUS_I18N_KEYS[status] ? t(STATUS_I18N_KEYS[status]) : status;
  const platformLabel = getPlatformLabel(t, platform);
  const dataSourceLabels = dataSources.map((s) => getPlatformLabel(t, s));
  const created = new Date(createdAt).toLocaleDateString('pt-BR');
  const updated = new Date(updatedAt).toLocaleDateString('pt-BR');

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      <Heading level={1} as="h3" color="secondary">
        {t('admin.workerDetail.status')}
      </Heading>
      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <Text size="sm" color="secondary">{t('admin.workerDetail.statusLabel')}</Text>
          <span className={`px-3 py-1 rounded-full ${colorClass}`}>
            <Text as="span" size="sm" weight="medium" color="inherit">
              {statusLabel}
            </Text>
          </span>
        </div>
        <div className="flex justify-between">
          <Text size="sm" color="secondary">
            {t('admin.workerDetail.platform')}
          </Text>
          <Text size="sm" weight="medium">{platformLabel}</Text>
        </div>
        {dataSources.length > 0 && (
          <div className="flex justify-between">
            <Text size="sm" color="secondary">
              {t('admin.workerDetail.dataSources')}
            </Text>
            <Text size="sm" weight="medium">{dataSourceLabels.join(', ')}</Text>
          </div>
        )}
        <div className="flex justify-between">
          <Text size="sm" color="secondary">
            {t('admin.workerDetail.createdAt')}
          </Text>
          <Text size="sm" weight="medium">{created}</Text>
        </div>
        <div className="flex justify-between">
          <Text size="sm" color="secondary">
            {t('admin.workerDetail.updatedAt')}
          </Text>
          <Text size="sm" weight="medium">{updated}</Text>
        </div>
      </div>
    </div>
  );
}
