import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientCoverageEditDrawer } from './edit/PatientCoverageEditDrawer';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';

interface CoberturaMedicaCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta cobertura") — abre este drawer. */
  focusRequest?: DrawerFocusRequest | null;
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

export function CoberturaMedicaCard({ patient, onSaved, focusRequest }: CoberturaMedicaCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  useAutoOpenDrawer(focusRequest, 'COVERAGE', () => setEditing(true));
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
        {/* D286 — abre o drawer que faz PATCH /patients/:id/coverage → patient_coverage:write. */}
        <ActionButton resource="patient_coverage" action="write" variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-coverage-btn">
          {t('admin.patients.detail.edit')}
        </ActionButton>
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
        {/* Spec 014 US-D2: "Números de Emergencia" REMOVIDO — era `value={null}` fixo, sem
            coluna no schema (decisão Gabriel 03/09, item 9). */}
        <Field
          label={t('admin.patients.detail.coverageCard.credential')}
          value={patient.affiliateId}
        />
      </div>
    </div>
  );
}
