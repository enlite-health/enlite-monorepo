import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { sortDiagnosesForCard } from '@domain/entities/diagnosisDisplay';
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
  const patologias = sortDiagnosesForCard(patient.diagnoses);

  return (
    <div data-testid="diagnostico-card" className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.diagnosisCard.title')}
        </Heading>
        {/* D269 — abre o drawer que faz PATCH /patients/:id/clinical → patient:write. */}
        <ActionButton resource="patient_clinical" action="write" variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-clinical-btn">
          {t('admin.patients.detail.edit')}
        </ActionButton>
      </div>

      {editing && (
        <PatientClinicalEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <div className="flex flex-col gap-2.5">
        {/* Spec 016 F3 (REQ-21): patología estruturada — SÓ o título, nunca o código. Bulkhead
            do backend (C4): `diagnosesUnavailable` distingue "não consegui ler" de "sem diagnóstico". */}
        {patient.diagnosesUnavailable ? (
          <Text size="sm" className="!text-red-600" data-testid="diagnostico-card-unavailable">
            {t('admin.patients.detail.diagnosisCard.patologiesUnavailable')}
          </Text>
        ) : (
          <div className="flex flex-col gap-1" data-testid="diagnostico-card-patologias">
            {patologias.length === 0 ? (
              <Text size="sm" color="muted" data-testid="diagnostico-card-patologias-empty">
                {t('admin.patients.detail.diagnosisCard.patologiesEmpty')}
              </Text>
            ) : (
              patologias.map((d) => (
                <Text key={d.id} size="sm" data-testid={`diagnostico-card-patologia-${d.id}`}>
                  {d.isPrimary && (
                    <Text as="span" size="xs" weight="medium" color="primary" className="mr-1.5">
                      {t('admin.patients.detail.diagnosisCard.patologiesPrimaryBadge')}:
                    </Text>
                  )}
                  <Text as="span" size="sm" color="muted">{d.title}</Text>
                </Text>
              ))
            )}
          </div>
        )}
        {/* 05/09 (Gabriel): o texto livre "Hipótesis Diagnóstica - CID" SAIU da ficha e do drawer —
            ao lado da patología estruturada ele confundia e convidava a digitar errado. A coluna
            `diagnosis` segue viva (espelho do ClickUp + backfill da F4), só não é mais mostrada aqui. */}
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
