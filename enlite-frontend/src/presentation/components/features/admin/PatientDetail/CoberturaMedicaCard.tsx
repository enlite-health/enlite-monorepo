import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail } from '@domain/entities/PatientDetail';

interface CoberturaMedicaCardProps {
  patient: PatientDetail;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col">
      <Text size="sm" weight="medium" color="muted">
        {label}
      </Text>
      <Text size="sm" color="muted">
        {value ?? '—'}
      </Text>
    </div>
  );
}

export function CoberturaMedicaCard({ patient }: CoberturaMedicaCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="cobertura-medica-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.coverageCard.title')}
        </Heading>
        <Button variant="primary" size="sm" disabled onClick={() => {}}>
          {t('admin.patients.detail.edit')}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
        <Field
          label={t('admin.patients.detail.coverageCard.providerName')}
          value={patient.insuranceInformed}
        />
        <Field
          label={t('admin.patients.detail.coverageCard.plan')}
          value={patient.insuranceVerified}
        />
        <Field
          label={t('admin.patients.detail.coverageCard.emergencyNumbers')}
          value={null}
        />
        <Field
          label={t('admin.patients.detail.coverageCard.credential')}
          value={patient.affiliateId}
        />
      </div>
    </div>
  );
}
