import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientCoverageEditDrawer } from './edit/PatientCoverageEditDrawer';

interface CoberturaMedicaCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
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

export function CoberturaMedicaCard({ patient, onSaved }: CoberturaMedicaCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // Spec 012, US-B3: as verificadas por CÓDIGO do catálogo (traduzidas); o escalar antigo
  // (`insuranceVerified`, rótulo cru do ClickUp) só aparece quando não há código nenhum.
  const codes = patient.insuranceVerifiedCodes ?? [];
  const verifiedLabel = codes.length > 0
    ? codes.map((c) => t(`admin.patients.insuranceProviderOptions.${c}`, c)).join(', ')
    : patient.insuranceVerified;

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="cobertura-medica-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.coverageCard.title')}
        </Heading>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-coverage-btn">
          {t('admin.patients.detail.edit')}
        </Button>
      </div>

      {editing && (
        <PatientCoverageEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
        <Field
          label={t('admin.patients.detail.coverageCard.providerName')}
          value={patient.insuranceInformed}
        />
        <div data-testid="coverage-verified">
          <Field
            label={t('admin.patients.detail.coverageCard.verified')}
            value={verifiedLabel}
          />
        </div>
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
