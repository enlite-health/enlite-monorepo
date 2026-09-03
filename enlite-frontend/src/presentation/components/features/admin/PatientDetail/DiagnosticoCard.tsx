import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientClinicalEditDrawer } from './edit/PatientClinicalEditDrawer';
import { ClinicalLongText } from './ClinicalLongText';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';

interface DiagnosticoCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta consentimiento") — abre este drawer. */
  focusRequest?: DrawerFocusRequest | null;
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
  // Spec 014 US-D3: "Sim/Não" → "Sí/No" — `common.yes`/`common.no` não existiam em NENHUM
  // locale (não só no fallback morto): o texto pt-BR aparecia sempre, mesmo com a UI em es-AR.
  const display = value === null ? null : value ? t('common.yes') : t('common.no');
  return <Field label={label} value={display} />;
}

export function DiagnosticoCard({ patient, onSaved, focusRequest }: DiagnosticoCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  useAutoOpenDrawer(focusRequest, 'CONSENT', () => setEditing(true));

  // US-B4: dispositivos por catálogo, traduzidos. US-B8: "Tipos de patologías - ICHOM" /
  // "Especialidad" saíram do card (o segmento é máscara do projeto terapêutico, não da admissão).
  const devices = (patient.deviceTypes ?? []).map((d) => t(`admin.patients.deviceTypeOptions.${d}`, d));
  const devicesLabel = devices.length > 0 ? devices.join(', ') : null;

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
        {/* REQ-01: observações gerais — texto longo com autoria (lex C1.1: máscara do Clarity dentro do componente). */}
        <ClinicalLongText
          testId="general-notes"
          label={`${t('admin.patients.detail.diagnosisCard.generalNotes')}:`}
          text={patient.additionalComments}
          updatedAt={patient.additionalCommentsUpdatedAt}
          updatedBy={patient.additionalCommentsUpdatedBy}
        />
        {/* D211.2: instruções de emergência — mesmo molde, com o estado REDIGIDO decidido pelo backend (ponto único). */}
        <ClinicalLongText
          testId="emergency-instructions"
          label={`${t('admin.patients.detail.diagnosisCard.emergencyInstructions')}:`}
          text={patient.emergencyInstructions}
          updatedAt={patient.emergencyInstructionsUpdatedAt}
          updatedBy={patient.emergencyInstructionsUpdatedBy}
          redactedMessage={patient.emergencyInstructionsRedacted ? t('admin.patients.detail.diagnosisCard.emergencyRedacted') : null}
        />
        <Field label={`${t('admin.patients.detail.diagnosisCard.devices')}:`} value={devicesLabel} />
        {/* Spec 014 US-D2: ¿Ya tiene acompañamiento?/¿Recibe dinero?/Conducta agresiva/
            Pensamiento suicida/Relato/Comentarios REMOVIDOS — eram `value={null}` fixo, sem
            campo em `patients` nesta spec (decisão Gabriel 03/09, item 9). */}
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.protectionCertificate')}:`} value={patient.hasJudicialProtection} />
        <BoolField label={`${t('admin.patients.detail.diagnosisCard.disabilityCertificate')}:`} value={patient.hasCud} />
      </div>
    </div>
  );
}
