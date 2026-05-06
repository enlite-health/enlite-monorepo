import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { WorkerServiceArea, WorkerLocation } from '@domain/entities/Worker';

interface WorkerLocationCardProps {
  serviceAreas: WorkerServiceArea[];
  location: WorkerLocation | null;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between">
      <Text size="sm" color="secondary">{label}</Text>
      <Text size="sm" weight="medium">{value ?? '—'}</Text>
    </div>
  );
}

export function WorkerLocationCard({ serviceAreas, location }: WorkerLocationCardProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      <Heading level={1} as="h3" color="secondary">
        {t('admin.workerDetail.location')}
      </Heading>

      {/* Worker Location (Argentina) */}
      {location && (
        <div className="flex flex-col gap-3">
          <Field label={t('admin.workerDetail.address')} value={location.address} />
          <Field label={t('admin.workerDetail.city')} value={location.city} />
          <Field label={t('admin.workerDetail.workZone')} value={location.workZone} />
          <Field label={t('admin.workerDetail.interestZone')} value={location.interestZone} />
        </div>
      )}

      {/* Service Areas (Brazil) */}
      {serviceAreas.length > 0 && (
        <div className="flex flex-col gap-3">
          <Text size="sm" weight="medium" color="secondary">
            {t('admin.workerDetail.serviceAreas')}
          </Text>
          {serviceAreas.map((sa) => (
            <div key={sa.id} className="bg-slate-50 rounded-lg p-3 flex flex-col gap-1">
              <Text size="sm">
                {sa.address ?? '—'}
              </Text>
              <Text size="xs" color="secondary">
                {t('admin.workerDetail.radius')}: {sa.serviceRadiusKm ?? '—'} km
                {sa.lat != null && sa.lng != null && (
                  <Text as="span" size="xs" color="secondary" className="ml-2">({sa.lat.toFixed(4)}, {sa.lng.toFixed(4)})</Text>
                )}
              </Text>
            </div>
          ))}
        </div>
      )}

      {!location && serviceAreas.length === 0 && (
        <Text size="sm" color="secondary">
          {t('admin.workerDetail.noLocation')}
        </Text>
      )}
    </div>
  );
}
