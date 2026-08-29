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

/** "28/08/2026, 14:35" no fuso de quem olha. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Observações gerais (REQ-01): texto longo com quebras preservadas + quem editou por
 * último e quando. `data-clarity-mask` — narrativa clínica não pode ir para a gravação
 * de sessão (lex 29/08, C1.1).
 */
function GeneralNotes({ label, patient }: { label: string; patient: PatientDetail }) {
  const { t } = useTranslation();
  const edited = patient.additionalCommentsUpdatedAt
    ? t('admin.patients.detail.diagnosisCard.lastEditedBy', {
        date: formatDateTime(patient.additionalCommentsUpdatedAt),
        name: patient.additionalCommentsUpdatedBy ?? '—',
      })
    : null;
  return (
    <div className="flex flex-col gap-1" data-clarity-mask="True" data-testid="general-notes">
      <Text as="span" size="sm" weight="medium" color="secondary">{label}</Text>
      <div data-testid="general-notes-text" className="whitespace-pre-wrap">
        <Text size="sm" color="muted" className="whitespace-pre-wrap leading-snug">{patient.additionalComments ?? '—'}</Text>
      </div>
      {edited && (
        <span data-testid="general-notes-edited">
          <Text as="span" size="xs" color="muted">{edited}</Text>
        </span>
      )}
    </div>
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
        <GeneralNotes label={`${t('admin.patients.detail.diagnosisCard.generalNotes')}:`} patient={patient} />
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
