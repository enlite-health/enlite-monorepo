import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { sortDiagnosesForCard } from '@domain/entities/diagnosisDisplay';
import { PatientClinicalEditDrawer } from './edit/PatientClinicalEditDrawer';
import { ClinicalLongText } from './ClinicalLongText';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { DetailRow, DetailRows } from './DetailRows';

interface DiagnosticoCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta consentimiento") — abre este drawer. */
  focusRequest?: DrawerFocusRequest | null;
}

/**
 * Rótulo de um grupo de linhas. Caixa-alta pequena com `tracking`, para ficar ABAIXO do título do
 * card na escada tipográfica — os grupos não podem competir com o nome do cartão.
 */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <Text as="span" size="xs" weight="medium" color="secondary" className="uppercase tracking-wider">
      {children}
    </Text>
  );
}

/**
 * Certificado é ESTADO, não frase: "Sí/No" obriga a ler, um ✓ e um ○ se conferem de relance.
 * O texto continua ali (leitor de tela e busca na página seguem funcionando); o ícone é
 * `aria-hidden` para não virar ruído duplicado.
 */
function BoolState({ value }: { value: boolean | null }) {
  const { t } = useTranslation();
  if (value === null) {
    return <Text as="span" size="sm" color="primary">—</Text>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={value ? 'text-green-700' : 'text-gray-800'}>
        {value ? '✓' : '○'}
      </span>
      <Text as="span" size="sm" color="primary">
        {value ? t('common.yes') : t('common.no')}
      </Text>
    </span>
  );
}

/** Dispositivo como chip: são poucos e curtos, e em chip a lista se lê sem vírgula. */
function DeviceChips({ devices }: { devices: string[] }) {
  if (devices.length === 0) {
    return <Text as="span" size="sm" color="primary">—</Text>;
  }
  return (
    <>
      {devices.map((d) => (
        <span key={d} className="inline-flex items-center rounded-pill bg-gray-200 border border-gray-600 px-2.5 py-0.5">
          <Text as="span" size="xs" color="primary">{d}</Text>
        </span>
      ))}
    </>
  );
}

export function DiagnosticoCard({ patient, onSaved, focusRequest }: DiagnosticoCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  useAutoOpenDrawer(focusRequest, 'CONSENT', () => setEditing(true));

  // US-B4: dispositivos por catálogo, traduzidos. US-B8: "Tipos de patologías - ICHOM" /
  // "Especialidad" saíram do card (o segmento é máscara do projeto terapêutico, não da admissão).
  const devices = (patient.deviceTypes ?? []).map((d) => t(`admin.patients.deviceTypeOptions.${d}`, d));
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

      {/* ── Patologías: o cabeçalho clínico do cartão ────────────────────────────────────────
          Fica em linha CHEIA, não em coluna estreita, por duas razões medidas: os títulos CID-11
          vêm inteiros da API e são longos ("Diabetes mellitus tipo 2 con complicaciones renales",
          51 caracteres) — numa coluna de ~260px cada um quebraria em 3-4 linhas; e a patología
          principal é o dado que se abre a ficha para ver, então não vai para a lateral.
          Spec 016 F3 (REQ-21): SÓ o título, nunca o código. Bulkhead do backend (C4):
          `diagnosesUnavailable` distingue "não consegui ler" de "sem diagnóstico". */}
      <div className="flex flex-col gap-1.5">
        <GroupLabel>{t('admin.patients.detail.diagnosisCard.patologies')}</GroupLabel>
        {patient.diagnosesUnavailable ? (
          <Text size="sm" className="!text-red-600" data-testid="diagnostico-card-unavailable">
            {t('admin.patients.detail.diagnosisCard.patologiesUnavailable')}
          </Text>
        ) : patologias.length === 0 ? (
          <Text size="sm" color="secondary" data-testid="diagnostico-card-patologias-empty">
            {t('admin.patients.detail.diagnosisCard.patologiesEmpty')}
          </Text>
        ) : (
          <DetailRows testId="diagnostico-card-patologias">
            {patologias.map((d) => (
              <div
                key={d.id}
                className="flex items-baseline gap-3 py-2.5 border-b border-gray-600"
                data-testid={`diagnostico-card-patologia-${d.id}`}
              >
                {/* A coluna do marcador tem largura fixa para os títulos alinharem entre si,
                    com ou sem chip. */}
                <span className="w-[72px] shrink-0">
                  {d.isPrimary && (
                    <span className="inline-flex items-center rounded-pill bg-clinic/10 px-2 py-0.5">
                      <Text as="span" size="2xs" weight="medium" className="!text-clinic">
                        {t('admin.patients.detail.diagnosisCard.patologiesPrimaryBadge')}
                      </Text>
                    </span>
                  )}
                </span>
                <Text as="span" size="sm" color="primary">{d.title}</Text>
              </div>
            ))}
          </DetailRows>
        )}
      </div>

      {/* ── Atributos curtos: é aqui que a linha com filete paga ───────────────────────────── */}
      <DetailRows>
        <DetailRow label={t('admin.patients.detail.diagnosisCard.devices')}>
          <DeviceChips devices={devices} />
        </DetailRow>
        {/* Spec 014 US-D2: ¿Ya tiene acompañamiento?/¿Recibe dinero?/Conducta agresiva/
            Pensamiento suicida/Relato/Comentarios REMOVIDOS — eram `value={null}` fixo, sem
            campo em `patients` nesta spec (decisão Gabriel 03/09, item 9). */}
        <DetailRow label={t('admin.patients.detail.diagnosisCard.disabilityCertificate')}>
          <BoolState value={patient.hasCud} />
        </DetailRow>
        <DetailRow label={t('admin.patients.detail.diagnosisCard.protectionCertificate')}>
          <BoolState value={patient.hasJudicialProtection} />
        </DetailRow>
      </DetailRows>

      {/* ── Narrativa clínica: FORA do ritmo de linhas ──────────────────────────────────────
          Estes dois têm parágrafos (`whitespace-pre-wrap`) e carregam a autoria embaixo — numa
          linha rótulo/valor destruiriam o alinhamento das outras. Lado a lado, cada um fica com
          metade da largura, que é o que aproxima a medida de linha do legível quando estão cheios.
          05/09 (Gabriel): o texto livre "Hipótesis Diagnóstica - CID" SAIU da ficha e do drawer —
          ao lado da patología estruturada ele confundia e convidava a digitar errado. A coluna
          `diagnosis` segue viva (espelho do ClickUp + backfill da F4), só não é mais mostrada. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-4">
        {/* REQ-01: observações gerais — texto longo com autoria (lex C1.1: máscara do Clarity dentro do componente). */}
        <ClinicalLongText
          testId="general-notes"
          label={t('admin.patients.detail.diagnosisCard.generalNotes')}
          text={patient.additionalComments}
          updatedAt={patient.additionalCommentsUpdatedAt}
          updatedBy={patient.additionalCommentsUpdatedBy}
          emptyMessage={t('admin.patients.detail.diagnosisCard.generalNotesEmpty')}
        />
        {/* D211.2: instruções de emergência — mesmo molde, com o estado REDIGIDO decidido pelo backend (ponto único). */}
        <ClinicalLongText
          testId="emergency-instructions"
          label={t('admin.patients.detail.diagnosisCard.emergencyInstructions')}
          text={patient.emergencyInstructions}
          updatedAt={patient.emergencyInstructionsUpdatedAt}
          updatedBy={patient.emergencyInstructionsUpdatedBy}
          redactedMessage={patient.emergencyInstructionsRedacted ? t('admin.patients.detail.diagnosisCard.emergencyRedacted') : null}
          emptyMessage={t('admin.patients.detail.diagnosisCard.emergencyInstructionsEmpty')}
        />
      </div>
    </div>
  );
}
