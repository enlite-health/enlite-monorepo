import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientClinicalEditDrawer } from './edit/PatientClinicalEditDrawer';

interface DiagnosticoCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <Text size="sm" className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <Text as="span" size="sm" color="muted">{value ?? '—'}</Text>
    </Text>
  );
}

function BoolField({ label, value }: { label: string; value: boolean | null }) {
  const { t } = useTranslation();
  const display = value === null ? null : value ? t('common.yes', 'Sim') : t('common.no', 'Não');
  return <Field label={label} value={display} />;
}

export function DiagnosticoCard({ patient, onSaved }: DiagnosticoCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  const specialtyLabel = patient.clinicalSpecialty
    ? t(`admin.patients.specialtyOptions.${patient.clinicalSpecialty}`, patient.clinicalSpecialty)
    : null;

  return (
    <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.diagnosisCard.title')}
        </Heading>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-clinical-btn">
          {t('admin.patients.detail.edit')}
        </Button>
      </div>

      {editing && (
        <PatientClinicalEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <div className="flex flex-col gap-2.5">
        <Field label={`${t('admin.patients.detail.diagnosisCard.cid')}:`} value={patient.diagnosis} />
        <Field label={`${t('admin.patients.detail.diagnosisCard.details')}:`} value={patient.additionalComments} />
        <Field label={`${t('admin.patients.detail.diagnosisCard.pathologyTypes')}:`} value={specialtyLabel} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.hasFollowUp')}:`} value={null} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.receivesMoney')}:`} value={null} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.aggressiveBehavior')}:`} value={null} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.suicidalIdeation')}:`} value={null} />
        <Field label={`${t('admin.patients.detail.diagnosisCard.patientReport')}:`} value={null} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.protectionCertificate')}:`} value={patient.hasJudicialProtection} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.disabilityCertificate')}:`} value={patient.hasCud} />
        <Field label={`${t('admin.patients.detail.diagnosisCard.comments')}:`} value={null} />
      </div>
    </div>
  );
}
